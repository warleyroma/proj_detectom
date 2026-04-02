// ============= VARIÁVEIS GLOBAIS =============
var NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
var MAJOR_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
var MINOR_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

var CHORD_MAPS = {
  "C": ["C","Dm","Em","F","G","Am"], "C#": ["C#","D#m","Fm","F#","G#","A#m"],
  "D": ["D","Em","F#m","G","A","Bm"], "D#": ["D#","Fm","Gm","G#","A#","Cm"],
  "E": ["E","F#m","G#m","A","B","C#m"], "F": ["F","Gm","Am","A#","C","Dm"],
  "F#": ["F#","G#m","A#m","B","C#","D#m"], "G": ["G","Am","Bm","C","D","Em"],
  "G#": ["G#","A#m","Cm","C#","D#","Fm"], "A": ["A","Bm","C#m","D","E","F#m"],
  "A#": ["A#","Cm","Dm","D#","F","Gm"], "B": ["B","C#m","D#m","E","F#","G#m"],
};

// Gerenciamento de Áudio
var globalStream = null;
var audioCtx = null;
var meydaAnalyser = null;
var assistenteInterval = null;
var chromaBuffer = new Array(12).fill(0);
var assistenteRunning = false;

// Afinador
var tunerAnalyser = null;
var tunerData = null;
var tunerRAF = null;
var tunerRunning = false;
var smoothedCents = 0;

function $(id) { return document.getElementById(id); }

// ============= UTILITÁRIOS DE ÁUDIO =============

async function startMic() {
    if (globalStream) stopAll();
    globalStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false, channelCount: 1 }
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return audioCtx.createMediaStreamSource(globalStream);
}

function stopAll() {
    stopAssistente();
    stopTuner();
    if (globalStream) {
        globalStream.getTracks().forEach(t => t.stop());
        globalStream = null;
    }
    if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close();
        audioCtx = null;
    }
}

// ============= ASSISTENTE (DETECÇÃO DE TOM) =============

function correlate(chroma, profile) {
    let n = 12;
    let mC = chroma.reduce((a,b) => a+b, 0) / n;
    let mP = profile.reduce((a,b) => a+b, 0) / n;
    let num = 0, dc = 0, dp = 0;
    for (let i = 0; i < n; i++) {
        let c = chroma[i] - mC, p = profile[i] - mP;
        num += c*p; dc += c*c; dp += p*p;
    }
    return (dc === 0 || dp === 0) ? 0 : num / Math.sqrt(dc * dp);
}

function detectKey(chroma) {
    let best = { key: "C", mode: "maior", score: -Infinity };
    for (let i = 0; i < 12; i++) {
        let rot = chroma.slice(i).concat(chroma.slice(0, i));
        let maj = correlate(rot, MAJOR_PROFILE);
        let min = correlate(rot, MINOR_PROFILE);
        if (maj > best.score) best = { key: NOTE_NAMES[i], mode: "maior", score: maj };
        if (min > best.score) best = { key: NOTE_NAMES[i], mode: "menor", score: min };
    }
    let confidence = Math.max(0, Math.min(1, (best.score + 1) / 2));
    return { key: best.key, mode: best.mode, confidence: confidence };
}

$("startBtn").onclick = async function() {
    if (assistenteRunning) { stopAssistente(); return; }
    try {
        let source = await startMic();
        meydaAnalyser = Meyda.createMeydaAnalyzer({
            audioContext: audioCtx,
            source: source,
            bufferSize: 2048,
            featureExtractors: ["chroma", "rms"],
            callback: function(f) {
                if (!f || !f.chroma || f.rms < 0.015) return;
                let sum = f.chroma.reduce((a, b) => a + b, 0);
                if (sum < 1e-6) return;
                let normalized = f.chroma.map(v => v / sum);
                for (let i = 0; i < 12; i++) {
                    chromaBuffer[i] = (chromaBuffer[i] * 0.92) + (normalized[i] * 0.08);
                }
            }
        });
        meydaAnalyser.start();

        assistenteInterval = setInterval(() => {
            if (chromaBuffer.reduce((a,b)=>a+b,0) < 0.01) return;
            let result = detectKey(chromaBuffer);
            $("key").textContent = result.key;
            $("mode").textContent = result.mode;
            $("fill").style.width = (result.confidence * 100) + "%";
            $("confidence").textContent = "Confiança: " + Math.round(result.confidence * 100) + "%";
            
            let chords = CHORD_MAPS[result.key] || [];
            $("chords").innerHTML = chords.map((c, i) => `<div class="chord-card ${i===0?'tonic':''}">${c}</div>`).join("");
            
            chromaBuffer = chromaBuffer.map(v => v * 0.93);
        }, 1000);

        assistenteRunning = true;
        $("startBtn").textContent = "⏹ Parar";
        $("startBtn").classList.add("danger");
    } catch(e) { console.error(e); }
};

function stopAssistente() {
    if (meydaAnalyser) { meydaAnalyser.stop(); meydaAnalyser = null; }
    clearInterval(assistenteInterval);
    chromaBuffer.fill(0);
    assistenteRunning = false;
    $("startBtn").textContent = "🎤 Iniciar";
    $("startBtn").classList.remove("danger");
}

// ============= AFINADOR (PITCH DETECTION) =============

function autoCorrelate(buf, sr) {
    let SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    if (Math.sqrt(rms / SIZE) < 0.015) return -1;

    let maxLag = Math.floor(sr / 30); // Limite p/ 30Hz (ajuda no Baixo e CPU)
    let c = new Float32Array(maxLag).fill(0);
    for (let i = 0; i < maxLag; i++) {
        for (let j = 0; j < SIZE - i; j++) { c[i] += buf[j] * buf[j + i]; }
    }

    let d = 0;
    while (d < maxLag - 1 && c[d] > c[d + 1]) d++;
    let maxval = -1, maxpos = -1;
    let threshold = 0.5 * c[0];

    for (let i = d; i < maxLag - 1; i++) {
        if (c[i] > c[i - 1] && c[i] > c[i + 1]) {
            if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
            if (maxval > threshold) break;
        }
    }
    if (maxpos === -1) return -1;

    let T0 = maxpos;
    let x1 = c[T0-1], x2 = c[T0], x3 = c[T0+1];
    let a = (x1 + x3 - 2 * x2) / 2;
    let b = (x3 - x1) / 2;
    if (a) T0 = T0 - b / (2 * a);
    return sr / T0;
}

function detectPitch() {
    if (!tunerRunning) return;
    tunerAnalyser.getFloatTimeDomainData(tunerData);
    let f = autoCorrelate(tunerData, audioCtx.sampleRate);

    if (f > 30 && f < 4000) {
        let n = Math.round(12 * Math.log2(f / 440)) + 69;
        let cents = Math.round(1200 * Math.log2(f / (440 * Math.pow(2, (n - 69) / 12))));
        
        smoothedCents = (smoothedCents * 0.8) + (cents * 0.2);
        let pct = ((Math.max(-50, Math.min(50, smoothedCents)) + 50) / 100) * 100;
        
        $("note").textContent = NOTE_NAMES[((n % 12) + 12) % 12];
        $("freq").textContent = f.toFixed(1) + " Hz";
        $("needle").style.left = pct + "%";
        $("needle").style.backgroundColor = Math.abs(cents) < 5 ? "#00ff66" : "#ef4444";
    }
    tunerRAF = requestAnimationFrame(detectPitch);
}

$("tunerBtn").onclick = async function() {
    if (tunerRunning) { stopTuner(); return; }
    try {
        let source = await startMic();
        let filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1800;
        
        tunerAnalyser = audioCtx.createAnalyser();
        tunerAnalyser.fftSize = 4096; // 4096 é suficiente e mais leve
        
        source.connect(filter);
        filter.connect(tunerAnalyser);
        
        tunerData = new Float32Array(tunerAnalyser.fftSize);
        tunerRunning = true;
        $("tunerBtn").textContent = "⏹ Parar Afinador";
        $("tunerBtn").classList.add("danger");
        detectPitch();
    } catch(e) { console.error(e); }
};

function stopTuner() {
    tunerRunning = false;
    if (tunerRAF) cancelAnimationFrame(tunerRAF);
    tunerAnalyser = null;
    $("tunerBtn").textContent = "🎯 Iniciar Afinador";
    $("tunerBtn").classList.remove("danger");
    $("note").textContent = "--";
    $("needle").style.left = "50%";
}