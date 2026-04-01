// ================= MENU =================
const menu = document.getElementById("menu");
const assistente = document.getElementById("assistente");
const afinador = document.getElementById("afinador");

document.getElementById("btnAssistente").onclick = () => {
    menu.classList.add("hidden");
    assistente.classList.remove("hidden");
};

document.getElementById("btnAfinador").onclick = () => {
    menu.classList.add("hidden");
    afinador.classList.remove("hidden");
};

document.getElementById("btnVoltar1").onclick = voltar;
document.getElementById("btnVoltar2").onclick = voltar;

function voltar() {
    stopAssistente();
    stopTuner();

    assistente.classList.add("hidden");
    afinador.classList.add("hidden");
    menu.classList.remove("hidden");
}

// ================= ASSISTENTE =================
let chromaBuffer = new Array(12).fill(0);
let analyser;
let intervalId;
let isRunning = false;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const startBtn = document.getElementById("startBtn");
const statusEl = document.getElementById("status");

startBtn.onclick = async () => {
    if (isRunning) stopAssistente();
    else await startAssistente();
};

async function startAssistente() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);

    analyser = Meyda.createMeydaAnalyzer({
        audioContext: ctx,
        source,
        bufferSize: 1024,
        featureExtractors: ["chroma"],
        callback: f => {
            if (!f?.chroma) return;
            for (let i = 0; i < 12; i++) chromaBuffer[i] += f.chroma[i];
        }
    });

    analyser.start();
    intervalId = setInterval(detectKey, 5000);

    statusEl.innerText = "🎤 Escutando...";
    isRunning = true;
}

function stopAssistente() {
    analyser?.stop();
    clearInterval(intervalId);
    chromaBuffer.fill(0);
    statusEl.innerText = "Parado";
    isRunning = false;
}

function detectKey() {
    let total = chromaBuffer.reduce((a, b) => a + b, 0);
    if (total < 0.01) return;

    let idx = chromaBuffer.indexOf(Math.max(...chromaBuffer));
    let tonic = NOTE_NAMES[idx];

    document.getElementById("key").innerText = tonic;
    document.getElementById("confidence").innerText = "Detectando...";
    document.getElementById("fill").style.width = "70%";

    chromaBuffer = chromaBuffer.map(v => v * 0.6);
}

// ================= AFINADOR =================
let audioCtx;
let analyserT;
let data;
let tunerRunning = false;

const tunerBtn = document.getElementById("tunerBtn");

tunerBtn.onclick = async () => {
    if (!tunerRunning) {
        tunerRunning = true;
        await startTuner();
        tunerBtn.innerText = "Parar Afinador";
    } else {
        stopTuner();
        tunerBtn.innerText = "Iniciar Afinador";
    }
};

async function startTuner() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    console.log("Microfone conectado"); // 🔥 DEBUG


    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);

    analyserT = audioCtx.createAnalyser();
    analyserT.fftSize = 2048;

    source.connect(analyserT);
    data = new Float32Array(analyserT.fftSize);

    detectPitch();
}

function stopTuner() {
    audioCtx?.close();
    tunerRunning = false;
}

function detectPitch() {
    if (!tunerRunning) {
        requestAnimationFrame(detectPitch);
        return;
    }

    analyserT.getFloatTimeDomainData(data);

    let freq = autoCorrelate(data, audioCtx.sampleRate);

    if (freq !== -1) {
        let noteData = getNoteData(freq);

        document.getElementById("note").innerText = noteData.note;
        document.getElementById("freq").innerText = freq.toFixed(1) + " Hz";
        document.getElementById("cents").innerText = noteData.cents + " cents";

        updateNeedle(noteData.cents);
    }

    requestAnimationFrame(detectPitch);
}

function autoCorrelate(buf, sr) {
    let SIZE = buf.length;
    let best = -1;
    let bestCorr = 0;

    for (let offset = 8; offset < 1000; offset++) {
        let corr = 0;
        for (let i = 0; i < SIZE - offset; i++) {
            corr += buf[i] * buf[i + offset];
        }
        corr /= SIZE;

        if (corr > bestCorr) {
            bestCorr = corr;
            best = offset;
        }
    }

    return best > 0 ? sr / best : -1;
}

function getNoteData(freq) {
    const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

    let n = 12 * (Math.log(freq / 440) / Math.log(2));
    n = Math.round(n) + 69;

    let perfect = 440 * Math.pow(2, (n - 69) / 12);
    let cents = Math.floor(1200 * Math.log2(freq / perfect));

    return {
        note: notes[n % 12] + (Math.floor(n / 12) - 1),
        cents
    };
}

function updateNeedle(cents) {
    let max = 50;
    if (cents > max) cents = max;
    if (cents < -max) cents = -max;

    let percent = (cents + 50) / 100;
    document.getElementById("needle").style.left = (percent * 100) + "%";

    document.getElementById("needle").style.background =
        Math.abs(cents) < 5 ? "lime" : "red";
}