let chromaBuffer = new Array(12).fill(0);
let analyser;

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B"
];

const MAJOR_PROFILE = [
  6.35,
  2.23,
  3.48,
  2.33,
  4.38,
  4.09,
  2.52,
  5.19,
  2.39,
  3.66,
  2.29,
  2.88
];
const MINOR_PROFILE = [
  6.33,
  2.68,
  3.52,
  5.38,
  2.6,
  3.53,
  2.54,
  4.75,
  3.98,
  2.69,
  3.34,
  3.17
];

document.getElementById("startBtn").addEventListener("click", start);

async function start() {
  console.log("Botão clicado");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log("Microfone liberado");

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);

    if (typeof Meyda === "undefined") {
      alert("Meyda NÃO carregou!");
      return;
    }

    console.log("Meyda OK");

    analyser = Meyda.createMeydaAnalyzer({
      audioContext: audioContext,
      source: source,
      bufferSize: 1024,
      featureExtractors: ["chroma"],
      callback: (features) => {
        if (!features || !features.chroma) return;

        for (let i = 0; i < 12; i++) {
          chromaBuffer[i] += features.chroma[i];
        }
      }
    });

    analyser.start();
    console.log("Analisador iniciado");

    setInterval(detectKey, 2000);
  } catch (err) {
    console.error("Erro:", err);
    alert("Erro ao acessar microfone: " + err.message);
  }
}

function detectKey() {
  let results = [];

  for (let i = 0; i < 12; i++) {
    let majorScore = correlation(rotate(MAJOR_PROFILE, i), chromaBuffer);
    let minorScore = correlation(rotate(MINOR_PROFILE, i), chromaBuffer);

    results.push({ key: NOTE_NAMES[i] + " Maior", score: majorScore });
    results.push({ key: NOTE_NAMES[i] + " Menor", score: minorScore });
  }

  results.sort((a, b) => b.score - a.score);

  let top3 = results.slice(0, 3);

  let totalEnergy = chromaBuffer.reduce((a,b) => a+b, 0);

  let output = top3.map(r => {
    let conf = totalEnergy ? ((r.score / totalEnergy) * 100).toFixed(1) : 0;
    return `${r.key} (${conf}%)`;
  }).join("\n");

  document.getElementById("key").innerText = output;

  chromaBuffer.fill(0);
}

function rotate(arr, n) {
  return arr.slice(n).concat(arr.slice(0, n));
}

function correlation(a, b) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}
