let chromaBuffer = new Array(12).fill(0);
let analyser;

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

const MAJOR_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

document.getElementById("startBtn").addEventListener("click", start);

async function start() {
  try {
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

    setInterval(detectKey, 2000);

  } catch (err) {
    alert("Erro ao acessar microfone: " + err.message);
    console.error(err);
  }
}

function detectKey() {
  let results = [];

  for (let i = 0; i < 12; i++) {
    let majorScore = correlation(rotate(MAJOR_PROFILE, i), chromaBuffer);
    let minorScore = correlation(rotate(MINOR_PROFILE, i), chromaBuffer);

    results.push({ key: NOTE_NAMES[i], type: "Maior", score: majorScore });
    results.push({ key: NOTE_NAMES[i], type: "Menor", score: minorScore });
  }

  results.sort((a, b) => b.score - a.score);

  let top = results.slice(0, 3);

  let totalEnergy = chromaBuffer.reduce((a,b) => a+b, 0);

  // Mostrar TOP 3
  let text = top.map((r, i) => {
    let conf = totalEnergy ? ((r.score / totalEnergy) * 100).toFixed(1) : 0;
    return `${i+1}. ${r.key} ${r.type} (${conf}%)`;
  }).join("\n");

  document.getElementById("key").innerText = text;

  // Barra de confiança do primeiro
  let best = top[0];
  let confidence = totalEnergy ? Math.min(100, (best.score / totalEnergy) * 100) : 0;

  document.getElementById("confidence").innerText =
    "Confiança: " + confidence.toFixed(1) + "%";

  document.getElementById("fill").style.width = confidence + "%";

  // Campo harmônico
  let chords = getField(best.key, best.type);

  document.getElementById("chords").innerText =
    `🎵 Campo harmônico (${best.key} ${best.type}):\n\n` +
    chords.join("   •   ");

  chromaBuffer.fill(0);
}

function rotate(arr, n) {
  return arr.slice(n).concat(arr.slice(0,n));
}

function correlation(a, b) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function getField(root, type) {
  const notes = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

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