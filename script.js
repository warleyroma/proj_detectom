let chromaBuffer = new Array(12).fill(0);
let analyser;
let intervalId;
let isRunning = false;

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

const btn = document.getElementById("startBtn");
const statusEl = document.getElementById("status");

btn.addEventListener("click", toggle);

async function toggle() {
  if (isRunning) {
    stop();
  } else {
    await start();
  }
}

async function start() {
  try {
    statusEl.innerText = "Status: Iniciando...";
    btn.innerText = "Parar";

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);

    analyser = Meyda.createMeydaAnalyzer({
      audioContext: audioContext,
      source: source,
      bufferSize: 1024,
      featureExtractors: ["chroma"],
      callback: features => {
        if (!features || !features.chroma) return;

        for (let i = 0; i < 12; i++) {
          chromaBuffer[i] += features.chroma[i];
        }
      }
    });

    analyser.start();

    intervalId = setInterval(detectKey, 5000);

    statusEl.innerText = "🎤 Escutando...";
    isRunning = true;

  } catch (err) {
    statusEl.innerText = "❌ Erro no microfone";
    console.error(err);
  }
}

function stop() {
  if (analyser) analyser.stop();
  clearInterval(intervalId);

  chromaBuffer.fill(0);

  statusEl.innerText = "⏹️ Parado";
  btn.innerText = "Iniciar";
  isRunning = false;
}

function detectKey() {
  let totalEnergy = chromaBuffer.reduce((a,b) => a+b, 0);

  // DEBUG: mostrar se está captando som
  if (totalEnergy < 0.01) {
    statusEl.innerText = "🔇 Sem som detectado...";
    return;
  } else {
    statusEl.innerText = "🎤 Escutando som...";
  }

  let tonicIndex = chromaBuffer.indexOf(Math.max(...chromaBuffer));
  let tonic = NOTE_NAMES[tonicIndex];

  const majorSteps = [0,2,4,5,7,9,11];
  const minorSteps = [0,2,3,5,7,8,10];

  function buildScale(rootIndex, steps) {
    return steps.map(s => (rootIndex + s) % 12);
  }

  let majorScale = buildScale(tonicIndex, majorSteps);
  let minorScale = buildScale(tonicIndex, minorSteps);

  function scoreScale(scale) {
    return scale.reduce((sum, i) => sum + chromaBuffer[i], 0);
  }

  let majorScore = scoreScale(majorScale);
  let minorScore = scoreScale(minorScale);

  let type = majorScore > minorScore ? "Maior" : "Menor";

  let confidence = Math.max(majorScore, minorScore) / totalEnergy * 100;
  confidence = Math.min(100, confidence);

  let relative = getRelative(tonic, type);

  document.getElementById("key").innerText =
    `🎯 Tônica: ${tonic}\n🎵 Tonalidade: ${tonic} ${type}\n🔁 Relativo: ${relative}`;

  document.getElementById("confidence").innerText =
    "Confiança: " + confidence.toFixed(1) + "%";

  document.getElementById("fill").style.width = confidence + "%";

  let chords = getField(tonic, type);

  document.getElementById("chords").innerText =
    `🎸 Campo harmônico:\n\n` +
    chords.join("   •   ");

  chromaBuffer = chromaBuffer.map(v => v * 0.6);
}

function getRelative(tonic, type) {
  let index = NOTE_NAMES.indexOf(tonic);

  if (type === "Maior") {
    return NOTE_NAMES[(index + 9) % 12] + " Menor";
  } else {
    return NOTE_NAMES[(index + 3) % 12] + " Maior";
  }
}

function getField(root, type) {
  const notes = NOTE_NAMES;

  const majorSteps = [0,2,4,5,7,9,11];
  const minorSteps = [0,2,3,5,7,8,10];

  let index = notes.indexOf(root);

  let scale = (type === "Maior" ? majorSteps : minorSteps)
    .map(step => notes[(index + step) % 12]);

  if (type === "Maior") {
    return [
      scale[0],
      scale[1]+"m",
      scale[2]+"m",
      scale[3],
      scale[4],
      scale[5]+"m",
      scale[6]+"dim"
    ];
  } else {
    return [
      scale[0]+"m",
      scale[1]+"dim",
      scale[2],
      scale[3]+"m",
      scale[4]+"m",
      scale[5],
      scale[6]
    ];
  }
}