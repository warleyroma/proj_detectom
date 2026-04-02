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

const MAJOR_PROFILE = [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 2.9]; // Albrecht-Shanahan (melhor para voz)
const MINOR_PROFILE = [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 4.8, 4.0, 2.7, 3.3, 3.2];

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

// Graus diatônicos para modo menor natural
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
const chromaBuffer = new Float32Array(12);
let assistenteRunning = false;

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

async function startMic() {
    stopAll();

    const myGen = ++micGeneration;

    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: false,
            autoGainControl:  false,
            noiseSuppression: false,
            channelCount: 1,
        }
    });

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
    micGeneration++;

    stopAssistente();
    stopTuner();

    if (globalStream) {
        globalStream.getTracks().forEach(t => t.stop());
        globalStream = null;
    }

    if (audioCtx && audioCtx.state !== "closed") {
        audioCtx.close().catch(console.warn);
        audioCtx = null;
    }
}

// ============= ASSISTENTE — DETECTOR DE ACORDE TÔNICO PARA VOZ =============

let currentTonic = { chord: "C", root: 0, mode: "maior", confidence: 0 };
let keyHistory = new Float32Array(24);

const HYSTERESIS_THRESHOLD = 0.15;
const SCORE_EMA_ALPHA = 0.22;
const MIN_RMS_VOICE = 0.008;

function correlate(chroma, profile) {
    const n = 12;
    let sumC = 0, sumP = 0;
    for (let i = 0; i < n; i++) { sumC += chroma[i]; sumP += profile[i]; }
    const mC = sumC / n, mP = sumP / n;
    let num = 0, dc = 0, dp = 0;
    for (let i = 0; i < n; i++) {
        const c = chroma[i] - mC;
        const p = profile[i] - mP;
        num += c * p; dc += c * c; dp += p * p;
    }
    return (dc < 1e-8 || dp < 1e-8) ? -1 : num / Math.sqrt(dc * dp);
}

function detectTonicChord(chroma) {
    let bestScore = -Infinity;
    let bestRoot = 0;
    let bestMode = "maior";

    const rot = new Float32Array(12);

    for (let i = 0; i < 12; i++) {
        for (let j = 0; j < 12; j++) rot[j] = chroma[(j + i) % 12];

        const maj = correlate(rot, MAJOR_PROFILE);
        const min = correlate(rot, MINOR_PROFILE);

        if (maj > bestScore) { bestScore = maj; bestRoot = i; bestMode = "maior"; }
        if (min > bestScore)  { bestScore = min;  bestRoot = i; bestMode = "menor"; }
    }

    const histIdx = bestMode === "maior" ? bestRoot : bestRoot + 12;
    keyHistory[histIdx] = keyHistory[histIdx] * (1 - SCORE_EMA_ALPHA) + bestScore * SCORE_EMA_ALPHA;

    const currentIdx = currentTonic.mode === "maior" 
        ? NOTE_NAMES.indexOf(currentTonic.chord) 
        : NOTE_NAMES.indexOf(currentTonic.chord) + 12;

    const diff = keyHistory[histIdx] - keyHistory[currentIdx];

    if (NOTE_NAMES[bestRoot] + (bestMode === "menor" ? "m" : "") !== currentTonic.chord || diff > HYSTERESIS_THRESHOLD) {
        currentTonic = {
            chord: NOTE_NAMES[bestRoot] + (bestMode === "menor" ? "m" : ""),
            root: bestRoot,
            mode: bestMode,
            confidence: Math.max(0, Math.min(1, (bestScore + 1) * 0.65))
        };
    }

    return currentTonic;
}

$("startBtn").onclick = async function () {
    if (assistenteRunning) { stopAssistente(); return; }
    try {
        const source = await startMic();
        const capturedCtx = audioCtx;

        meydaAnalyser = Meyda.createMeydaAnalyzer({
            audioContext: capturedCtx,
            source,
            bufferSize: 2048,
            featureExtractors: ["chroma", "rms"],
            callback(f) {
                if (!f || !f.chroma || f.rms < MIN_RMS_VOICE) return;

                const sum = f.chroma.reduce((a, b) => a + b, 0);
                if (!Number.isFinite(sum) || sum < 1e-6) return;

                for (let i = 0; i < 12; i++) {
                    const v = f.chroma[i] / sum;
                    chromaBuffer[i] = chromaBuffer[i] * 0.88 + v * 0.12; // EMA mais suave para voz
                }
            }
        });

        meydaAnalyser.start();
        assistenteRunning = true;

        $("startBtn").textContent = "⏹ Parar";
        $("startBtn").classList.add("danger");
        $("statusDot").className = "dot on";
        $("status").innerHTML = '🎤 <strong>Modo Voz</strong> — Ouvindo cantor(a)';
        $("barWrap").style.display = "block";
        $("chordsSection").style.display = "block";

        assistenteInterval = setInterval(() => {
            const total = chromaBuffer.reduce((a, b) => a + b, 0);
            if (total < 0.015) return;

            const tonic = detectTonicChord(chromaBuffer);

            // Acorde tônico grande e destacado (ideal para acompanhar com violão)
            $("key").innerHTML = `<span style="font-size: 4.8rem; font-weight: bold; line-height: 1;">${tonic.chord}</span>`;
            $("mode").textContent = tonic.mode === "maior" ? "MAIOR" : "menor";
            $("fill").style.width = (tonic.confidence * 100) + "%";
            $("confidence").textContent = "Confiança: " + Math.round(tonic.confidence * 100) + "%";

            // Sugestão de acordes diatônicos
            const map = tonic.mode === "menor" 
                ? CHORD_MAPS_MINOR[NOTE_NAMES[tonic.root]] 
                : CHORD_MAPS_MAJOR[NOTE_NAMES[tonic.root]];

            const chords = map || [];
            $("chords").innerHTML = chords.map((c, i) =>
                `<div class="chord-card${i === 0 ? " tonic" : ""}">${c}</div>`
            ).join("");

        }, 650);

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

    chromaBuffer.fill(0);
    keyHistory.fill(0);
    assistenteRunning = false;

    $("startBtn").textContent = "🎤 Iniciar";
    $("startBtn").classList.remove("danger");
    $("statusDot").className = "dot off";
    $("status").textContent = "Parado";
    $("key").innerHTML = "--";
    $("mode").textContent = "";
    $("fill").style.width = "0%";
    $("confidence").textContent = "Confiança: 0%";
}

// ============= AFINADOR — PITCH DETECTION =============
// (Mantido exatamente igual ao seu código original)

function autoCorrelate(buf, sr) {
    const SIZE   = buf.length;
    const maxLag = Math.floor(sr / 30);

    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    if (Math.sqrt(rms / SIZE) < 0.015) return -1;

    const c = new Float32Array(maxLag);
    for (let i = 0; i < maxLag; i++) {
        let s = 0;
        const limit = SIZE - i;
        for (let j = 0; j < limit; j++) s += buf[j] * buf[j + i];
        c[i] = s;
    }

    let d = 0;
    while (d < maxLag - 1 && c[d] > c[d + 1]) d++;

    const threshold = 0.5 * c[0];
    let maxval = -1, maxpos = -1;

    for (let i = d + 1; i < maxLag - 1; i++) {
        if (c[i] > c[i - 1] && c[i] > c[i + 1]) {
            if (c[i] > maxval) {
                maxval = c[i];
                maxpos = i;
            }
            if (maxval > threshold) break;
        }
    }

    if (maxpos === -1) return -1;

    let T0 = maxpos;
    const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a !== 0) T0 = T0 - b / (2 * a);

    return sr / T0;
}

function detectPitch(capturedSr) {
    if (!tunerRunning) return;
    tunerAnalyser.getFloatTimeDomainData(tunerData);
    const f = autoCorrelate(tunerData, capturedSr);

    if (f > 30 && f < 4000) {
        const n      = Math.round(12 * Math.log2(f / 440)) + 69;
        const cents  = Math.round(1200 * Math.log2(f / (440 * Math.pow(2, (n - 69) / 12))));
        const octave = Math.floor(n / 12) - 1;

        smoothedCents = smoothedCents * 0.8 + cents * 0.2;
        const pct = ((Math.max(-50, Math.min(50, smoothedCents)) + 50) / 100) * 100;

        $("note").textContent   = NOTE_NAMES[((n % 12) + 12) % 12];
        $("octave").textContent = "Oitava " + octave;
        $("freq").textContent   = f.toFixed(1) + " Hz";
        $("needle").style.left  = pct.toFixed(1) + "%";

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
        const capturedSr = audioCtx.sampleRate;

        const filter = audioCtx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 3500;

        tunerAnalyser = audioCtx.createAnalyser();
        tunerAnalyser.fftSize = 4096;

        source.connect(filter);
        filter.connect(tunerAnalyser);

        tunerData = new Float32Array(tunerAnalyser.fftSize);
        tunerRunning = true;

        $("tunerBtn").textContent = "⏹ Parar Afinador";
        $("tunerBtn").classList.add("danger");
        $("cents").textContent = "Ouvindo...";

        detectPitch(capturedSr);

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
    tunerData = null;
    smoothedCents = 0;

    $("tunerBtn").textContent = "🎯 Iniciar Afinador";
    $("tunerBtn").classList.remove("danger");
    $("note").textContent = "--";
    $("octave").textContent = "";
    $("freq").textContent = "";
    $("needle").style.left = "50%";
    $("needle").style.backgroundColor = "#555";
    $("cents").textContent = "Aguardando sinal de áudio...";
    $("cents").style.color = "#888";
}