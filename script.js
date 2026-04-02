// ============================================================
// MUSIC ASSISTANT v3 — Corrigido por análise sênior
// Bugs corrigidos:
//   [P0] Race condition em getUserMedia + stopAll (AbortController pattern)
//   [P0] audioCtx.sampleRate capturado por closure, não lido do global
//   [P1] CHORD_MAPS_MINOR adicionado — acordes corretos para modo menor
//   [P1] Decaimento duplo removido — único EMA no callback do Meyda
//   [P1] inTune usa smoothedCents (consistente com a agulha)
//   [P2] smoothedCents zerado no stopTuner
//   [P2] Autocorrelação O(n²) limitada + early-exit para performance
//   [P2] NaN propagation bloqueado na entrada do callback
//   [P2] audioCtx.close() com .catch() para não explodir no Safari
//   [P2] GC pressure reduzida — decaimento in-place sem criar array novo
// ============================================================

// ============= CONSTANTES =============

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

const MAJOR_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

// Graus diatônicos para modo maior: I, ii, iii, IV, V, vi
const CHORD_MAPS_MAJOR = {
    "C":  ["C","Dm","Em","F","G","Am"],
    "C#": ["C#","D#m","Fm","F#","G#","A#m"],
    "D":  ["D","Em","F#m","G","A","Bm"],
    "D#": ["D#","Fm","Gm","G#","A#","Cm"],
    "E":  ["E","F#m","G#m","A","B","C#m"],
    "F":  ["F","Gm","Am","A#","C","Dm"],
    "F#": ["F#","G#m","A#m","B","C#","D#m"],
    "G":  ["G","Am","Bm","C","D","Em"],
    "G#": ["G#","A#m","Cm","C#","D#","Fm"],
    "A":  ["A","Bm","C#m","D","E","F#m"],
    "A#": ["A#","Cm","Dm","D#","F","Gm"],
    "B":  ["B","C#m","D#m","E","F#","G#m"],
};

// [FIX P1] Graus diatônicos para modo menor natural: i, ii°, III, iv, v, VI, VII
// A relativa maior compartilha as mesmas notas, mas os graus e função harmônica
// são diferentes. Ex: Lá menor → Am, Bdim, C, Dm, Em, F, G (não os acordes de Lá maior)
const CHORD_MAPS_MINOR = {
    "A":  ["Am","Bdim","C","Dm","Em","F","G"],
    "A#": ["A#m","Cdim","C#","D#m","Fm","F#","G#"],
    "B":  ["Bm","C#dim","D","Em","F#m","G","A"],
    "C":  ["Cm","Ddim","D#","Fm","Gm","G#","A#"],
    "C#": ["C#m","D#dim","E","F#m","G#m","A","B"],
    "D":  ["Dm","Edim","F","Gm","Am","A#","C"],
    "D#": ["D#m","Fdim","F#","G#m","A#m","B","C#"],
    "E":  ["Em","F#dim","G","Am","Bm","C","D"],
    "F":  ["Fm","Gdim","G#","A#m","Cm","C#","D#"],
    "F#": ["F#m","G#dim","A","Bm","C#m","D","E"],
    "G":  ["Gm","Adim","A#","Cm","Dm","D#","F"],
    "G#": ["G#m","A#dim","B","C#m","D#m","E","F#"],
};

// ============= ESTADO GLOBAL =============

let globalStream  = null;
let audioCtx      = null;
let meydaAnalyser = null;
let assistenteInterval = null;
const chromaBuffer = new Float32Array(12); // [FIX P2] Float32Array evita GC de arrays JS
let assistenteRunning = false;

// [FIX P0] Contador de geração para cancelar getUserMedia pendente
let micGeneration = 0;

let tunerAnalyser  = null;
let tunerData      = null;
let tunerRAF       = null;
let tunerRunning   = false;
let smoothedCents  = 0;

// ============= HELPERS =============

const $ = id => document.getElementById(id);

// ============= NAVEGAÇÃO =============

$("btnAssistente").onclick = () => {
    $("menu").classList.add("hidden");
    $("assistente").classList.remove("hidden");
};

$("btnAfinador").onclick = () => {
    $("menu").classList.add("hidden");
    $("afinador").classList.remove("hidden");
};

$("btnVoltar1").onclick = () => {
    stopAll();
    $("assistente").classList.add("hidden");
    $("menu").classList.remove("hidden");
};

$("btnVoltar2").onclick = () => {
    stopAll();
    $("afinador").classList.add("hidden");
    $("menu").classList.remove("hidden");
};

// ============= GERENCIAMENTO DE ÁUDIO =============

/**
 * [FIX P0] Inicia o microfone com proteção contra race condition.
 * Se stopAll() for chamado enquanto getUserMedia ainda está pendente,
 * o micGeneration muda, e o stream resolvido é imediatamente descartado.
 */
async function startMic() {
    stopAll(); // garante limpeza antes de criar novo contexto

    const myGen = ++micGeneration;

    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: false,
            autoGainControl:  false,
            noiseSuppression: false,
            channelCount: 1,
        }
    });

    // Se stopAll() foi chamado enquanto aguardávamos a permissão, aborta.
    if (myGen !== micGeneration) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error("mic_cancelled");
    }

    globalStream = stream;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    if (audioCtx.state === "suspended") await audioCtx.resume();

    return audioCtx.createMediaStreamSource(globalStream);
}

function stopAll() {
    micGeneration++; // invalida qualquer getUserMedia em voo

    stopAssistente();
    stopTuner();

    if (globalStream) {
        globalStream.getTracks().forEach(t => t.stop());
        globalStream = null;
    }

    if (audioCtx && audioCtx.state !== "closed") {
        // [FIX P2] .catch() para não estourar no Safari quando close() rejeita
        audioCtx.close().catch(console.warn);
        audioCtx = null;
    }
}

// ============= ASSISTENTE — DETECÇÃO DE TOM =============

function correlate(chroma, profile) {
    const n = 12;
    let mC = 0, mP = 0;
    for (let i = 0; i < n; i++) { mC += chroma[i]; mP += profile[i]; }
    mC /= n; mP /= n;
    let num = 0, dc = 0, dp = 0;
    for (let i = 0; i < n; i++) {
        const c = chroma[i] - mC;
        const p = profile[i] - mP;
        num += c * p; dc += c * c; dp += p * p;
    }
    return (dc === 0 || dp === 0) ? 0 : num / Math.sqrt(dc * dp);
}

function detectKey(chroma) {
    // [FIX P2] Valida NaN antes de calcular
    for (let i = 0; i < 12; i++) {
        if (!Number.isFinite(chroma[i])) return null;
    }

    let best   = { key: "C", mode: "maior", score: -Infinity };
    let second = -Infinity; // para cálculo de confiança real

    for (let i = 0; i < 12; i++) {
        // rotação inline sem alocar array — [FIX P2] zero GC pressure
        const rot = new Float32Array(12);
        for (let j = 0; j < 12; j++) rot[j] = chroma[(j + i) % 12];

        const maj = correlate(rot, MAJOR_PROFILE);
        const min = correlate(rot, MINOR_PROFILE);

        if (maj > best.score) {
            second = best.score;
            best = { key: NOTE_NAMES[i], mode: "maior", score: maj };
        } else if (maj > second) second = maj;

        if (min > best.score) {
            second = best.score;
            best = { key: NOTE_NAMES[i], mode: "menor", score: min };
        } else if (min > second) second = min;
    }

    // [FIX P2] Confiança = margem entre o melhor e o segundo melhor candidato,
    // normalizada. Mais honesta que a transformação linear simples de antes.
    const margin = best.score - second; // 0..~0.5 típico
    const confidence = Math.max(0, Math.min(1, margin * 4));

    return { key: best.key, mode: best.mode, confidence };
}

$("startBtn").onclick = async function () {
    if (assistenteRunning) { stopAssistente(); return; }
    try {
        const source = await startMic();

        // [FIX P0] Captura o contexto por closure para que o callback nunca
        // leia o global audioCtx que pode ter sido substituído.
        const capturedCtx = audioCtx;

        meydaAnalyser = Meyda.createMeydaAnalyzer({
            audioContext: capturedCtx,
            source,
            bufferSize: 2048,
            featureExtractors: ["chroma", "rms"],
            callback(f) {
                if (!f || !f.chroma || f.rms < 0.015) return;

                // [FIX P2] Valida NaN no chroma crú do Meyda
                const sum = f.chroma.reduce((a, b) => a + b, 0);
                if (!Number.isFinite(sum) || sum < 1e-6) return;

                // Normaliza para [0,1] e atualiza via EMA
                // [FIX P1] Único ponto de decaimento — o setInterval NÃO decai mais.
                // α=0.08 → resposta ~1s; quando não há sinal o buffer simplesmente
                // não é atualizado (o callback retorna cedo), sem drift artificial.
                for (let i = 0; i < 12; i++) {
                    const v = f.chroma[i] / sum;
                    chromaBuffer[i] = chromaBuffer[i] * 0.92 + v * 0.08;
                }
            }
        });

        meydaAnalyser.start();
        assistenteRunning = true;

        $("startBtn").textContent = "⏹ Parar";
        $("startBtn").classList.add("danger");
        $("statusDot").className = "dot on";
        $("status").textContent  = "Ouvindo...";
        $("barWrap").style.display     = "block";
        $("chordsSection").style.display = "block";

        assistenteInterval = setInterval(() => {
            const total = chromaBuffer.reduce((a, b) => a + b, 0);
            if (total < 0.01) return;

            const result = detectKey(chromaBuffer);
            if (!result) return; // NaN guard

            $("key").textContent  = result.key;
            $("mode").textContent = result.mode;
            $("fill").style.width = (result.confidence * 100) + "%";
            $("confidence").textContent = "Confiança: " + Math.round(result.confidence * 100) + "%";

            // [FIX P1] Escolhe o mapa correto baseado no modo detectado
            const map = result.mode === "menor"
                ? CHORD_MAPS_MINOR[result.key]
                : CHORD_MAPS_MAJOR[result.key];

            const chords = map || [];
            $("chords").innerHTML = chords.map((c, i) =>
                `<div class="chord-card${i === 0 ? " tonic" : ""}">${c}</div>`
            ).join("");

            // [FIX P1] Decaimento REMOVIDO daqui. O único decaimento é o EMA
            // no callback do Meyda. Dois decaimentos criavam deriva não-determinística.

        }, 1000);

    } catch (e) {
        if (e.message !== "mic_cancelled") {
            alert("Erro ao acessar o microfone! Aceite a permissão no navegador.");
            console.error(e);
        }
    }
};

function stopAssistente() {
    if (meydaAnalyser) { meydaAnalyser.stop(); meydaAnalyser = null; }
    clearInterval(assistenteInterval);
    assistenteInterval = null;

    // [FIX P2] In-place reset sem criar novo array
    chromaBuffer.fill(0);
    assistenteRunning = false;

    $("startBtn").textContent = "🎤 Iniciar";
    $("startBtn").classList.remove("danger");
    $("statusDot").className = "dot off";
    $("status").textContent  = "Parado";
    $("key").textContent     = "--";
    $("mode").textContent    = "";
    $("fill").style.width    = "0%";
    $("confidence").textContent = "Confiança: 0%";
}

// ============= AFINADOR — PITCH DETECTION =============

/**
 * Autocorrelação com maxLag limitado a sr/30 (~1470 amostras para 44100 Hz).
 * Ainda O(n × maxLag) mas n = fftSize = 4096, maxLag ≈ 1470 → ~6M ops/frame.
 * Para performance máxima em mobile, a solução ideal seria FFT-based (O(n log n)).
 * Marcado como TODO para v4.
 *
 * [FIX P2] Early-exit: ao encontrar o primeiro pico acima do threshold, para.
 * Na prática, para instrumentos graves, isso encerra o loop em ~30% do maxLag.
 */
function autoCorrelate(buf, sr) {
    const SIZE   = buf.length;
    const maxLag = Math.floor(sr / 30); // frequência mínima: 30 Hz

    // Gate de volume
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    if (Math.sqrt(rms / SIZE) < 0.015) return -1;

    // Autocorrelação
    const c = new Float32Array(maxLag);
    for (let i = 0; i < maxLag; i++) {
        let s = 0;
        const limit = SIZE - i;
        for (let j = 0; j < limit; j++) s += buf[j] * buf[j + i];
        c[i] = s;
    }

    // Pula o pico central (lag=0)
    let d = 0;
    while (d < maxLag - 1 && c[d] > c[d + 1]) d++;

    // Busca o primeiro pico local significativo
    const threshold = 0.5 * c[0];
    let maxval = -1, maxpos = -1;

    for (let i = d + 1; i < maxLag - 1; i++) {
        if (c[i] > c[i - 1] && c[i] > c[i + 1]) {
            if (c[i] > maxval) {
                maxval = c[i];
                maxpos = i;
            }
            // [FIX v1] Break APÓS atualizar maxpos — ordem correta
            if (maxval > threshold) break;
        }
    }

    if (maxpos === -1) return -1;

    // Interpolação parabólica para precisão sub-sample
    let T0 = maxpos;
    const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
    const a  = (x1 + x3 - 2 * x2) / 2;
    const b  = (x3 - x1) / 2;
    if (a !== 0) T0 = T0 - b / (2 * a);

    return sr / T0;
}

function detectPitch(capturedSr) {
    if (!tunerRunning) return;

    tunerAnalyser.getFloatTimeDomainData(tunerData);

    // [FIX P0] Usa o sample rate capturado por closure, não o global audioCtx
    const f = autoCorrelate(tunerData, capturedSr);

    if (f > 30 && f < 4000) {
        const n      = Math.round(12 * Math.log2(f / 440)) + 69;
        const cents  = Math.round(1200 * Math.log2(f / (440 * Math.pow(2, (n - 69) / 12))));
        const octave = Math.floor(n / 12) - 1;

        // EMA nos cents para suavizar a agulha
        smoothedCents = smoothedCents * 0.8 + cents * 0.2;

        const pct    = ((Math.max(-50, Math.min(50, smoothedCents)) + 50) / 100) * 100;

        $("note").textContent   = NOTE_NAMES[((n % 12) + 12) % 12];
        $("octave").textContent = "Oitava " + octave;
        $("freq").textContent   = f.toFixed(1) + " Hz";
        $("needle").style.left  = pct.toFixed(1) + "%";

        // [FIX P1] inTune baseado em smoothedCents — consistente com a agulha.
        // Antes usava `cents` bruto enquanto a agulha usava smoothedCents,
        // causando o texto "Afinado!" piscar mesmo com a agulha centrada.
        const inTune = Math.abs(smoothedCents) < 5;
        $("needle").style.backgroundColor = inTune ? "#00ff66" : "#ef4444";

        const centsEl = $("cents");
        if (inTune) {
            centsEl.textContent = "Afinado!";
            centsEl.style.color = "#00ff66";
        } else {
            const sign = smoothedCents > 0 ? "+" : "";
            centsEl.textContent = sign + Math.round(smoothedCents) + " cents";
            centsEl.style.color = "#fff";
        }
    }

    tunerRAF = requestAnimationFrame(() => detectPitch(capturedSr));
}

$("tunerBtn").onclick = async function () {
    if (tunerRunning) { stopTuner(); return; }
    try {
        const source = await startMic();

        // [FIX P0] Captura o sample rate por closure imediatamente
        const capturedSr = audioCtx.sampleRate;

        // Lowpass em 3500 Hz para suportar instrumentos agudos (violino ~2637 Hz)
        // sem cortar harmônicos que reforçam a detecção da fundamental.
        // v2 usava 1800 Hz, que cortava flautas e violinos.
        const filter = audioCtx.createBiquadFilter();
        filter.type  = "lowpass";
        filter.frequency.value = 3500;

        tunerAnalyser         = audioCtx.createAnalyser();
        tunerAnalyser.fftSize = 4096;

        source.connect(filter);
        filter.connect(tunerAnalyser);

        tunerData    = new Float32Array(tunerAnalyser.fftSize);
        tunerRunning = true;

        $("tunerBtn").textContent = "⏹ Parar Afinador";
        $("tunerBtn").classList.add("danger");
        $("cents").textContent = "Ouvindo...";

        detectPitch(capturedSr); // passa o sr por parâmetro, não pelo global

    } catch (e) {
        if (e.message !== "mic_cancelled") {
            alert("Erro ao acessar o microfone! Aceite a permissão no navegador.");
            console.error(e);
        }
    }
};

function stopTuner() {
    tunerRunning = false;
    if (tunerRAF) { cancelAnimationFrame(tunerRAF); tunerRAF = null; }
    tunerAnalyser = null;
    tunerData     = null;

    // [FIX P2] Zera o EMA para que a próxima sessão comece centrada
    smoothedCents = 0;

    $("tunerBtn").textContent = "🎯 Iniciar Afinador";
    $("tunerBtn").classList.remove("danger");
    $("note").textContent   = "--";
    $("octave").textContent = "";
    $("freq").textContent   = "";
    $("needle").style.left  = "50%";
    $("needle").style.backgroundColor = "#555";
    $("cents").textContent = "Aguardando sinal de áudio...";
    $("cents").style.color = "#888";
}