// ============= VARIÁVEIS GLOBAIS =============

var NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

var MAJOR_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
var MINOR_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

var CHORD_MAPS = {
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

// Assistente
var meydaAnalyser     = null;
var assistenteInterval = null;
var chromaBuffer      = new Array(12).fill(0);
var assistenteRunning = false;

// Afinador
var tunerCtx      = null;
var tunerAnalyser = null;
var tunerData     = null;
var tunerRAF      = null;
var tunerRunning  = false;

// ============= HELPERS =============

function $(id) { return document.getElementById(id); }

function showPage(name) {
  ["menu","assistente","afinador"].forEach(function(p) {
    $(p).classList.add("hidden");
  });
  $(name).classList.remove("hidden");
}

// ============= NAVEGAÇÃO =============

$("btnAssistente").onclick = function() { stopTuner();      showPage("assistente"); };
$("btnAfinador").onclick   = function() { stopAssistente(); showPage("afinador"); };
$("btnVoltar1").onclick    = function() { stopAssistente(); showPage("menu"); };
$("btnVoltar2").onclick    = function() { stopTuner();      showPage("menu"); };

// ============= ASSISTENTE =============

function correlate(chroma, profile) {
  var n = chroma.length;
  var mC = chroma.reduce(function(a,b){ return a+b; }, 0) / n;
  var mP = profile.reduce(function(a,b){ return a+b; }, 0) / n;
  var num = 0, dc = 0, dp = 0;
  for (var i = 0; i < n; i++) {
    var c = chroma[i] - mC, p = profile[i] - mP;
    num += c*p; dc += c*c; dp += p*p;
  }
  return (dc === 0 || dp === 0) ? 0 : num / Math.sqrt(dc * dp);
}

function detectKey(chroma) {
  var best = { key: "C", mode: "maior", score: -Infinity };
  for (var i = 0; i < 12; i++) {
    var rot = chroma.slice(i).concat(chroma.slice(0, i));
    var maj = correlate(rot, MAJOR_PROFILE);
    var min = correlate(rot, MINOR_PROFILE);
    if (maj > best.score) best = { key: NOTE_NAMES[i], mode: "maior", score: maj };
    if (min > best.score) best = { key: NOTE_NAMES[i], mode: "menor", score: min };
  }
  var confidence = Math.max(0, Math.min(1, (best.score + 1) / 2));
  return { key: best.key, mode: best.mode, confidence: confidence };
}

$("startBtn").onclick = async function() {
  if (assistenteRunning) { stopAssistente(); return; }
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var ctx = new AudioContext();
    var source = ctx.createMediaStreamSource(stream);

    meydaAnalyser = Meyda.createMeydaAnalyzer({
      audioContext: ctx,
      source: source,
      bufferSize: 2048, // Aumentei um pouco para estabilizar graves e voz
      featureExtractors: ["chroma", "rms"], // <-- ADICIONADO "rms"
      callback: function(f) {
        if (!f || !f.chroma) return;
        
        // NOISE GATE: Só acumula o chroma se o volume for audível
        if (f.rms < 0.015) return; 

        for (var i = 0; i < 12; i++) {
            chromaBuffer[i] += f.chroma[i];
        }
      }
    });
    meydaAnalyser.start();

    assistenteInterval = setInterval(function() {
      var total = chromaBuffer.reduce(function(a,b){ return a+b; }, 0);
      if (total < 0.01) return;
      var result = detectKey(chromaBuffer);

      $("key").textContent = result.key;
      $("mode").textContent = result.mode;
      $("barWrap").style.display = "block";
      $("fill").style.width = (result.confidence * 100) + "%";
      $("confidence").textContent = "Confiança: " + Math.round(result.confidence * 100) + "%";

      var chords = CHORD_MAPS[result.key] || [];
      $("chordsSection").style.display = "block";
      $("chords").innerHTML = chords.map(function(c, i) {
        return '<div class="chord-card' + (i === 0 ? " tonic" : "") + '">' + c + '</div>';
      }).join("");

      chromaBuffer = chromaBuffer.map(function(v){ return v * 0.6; });
    }, 3000);

    assistenteRunning = true;
    $("startBtn").textContent = "⏹ Parar";
    $("startBtn").classList.add("danger");
    $("status").textContent = "Escutando...";
    $("statusDot").className = "dot on";

  } catch(e) {
    $("status").textContent = "Erro: permissão negada";
  }
};

function stopAssistente() {
  if (meydaAnalyser) meydaAnalyser.stop();
  clearInterval(assistenteInterval);
  chromaBuffer = new Array(12).fill(0);
  assistenteRunning = false;
  meydaAnalyser = null;
  $("startBtn").textContent = "🎤 Iniciar";
  $("startBtn").classList.remove("danger");
  $("status").textContent = "Parado";
  $("statusDot").className = "dot off";
}

// ============= AFINADOR =============

function autoCorrelate(buf, sampleRate) {
  var SIZE = buf.length;
  
  // 1. Cálculo de RMS (Energia do sinal) para ignorar silêncio
  var rms = 0;
  for (var i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // Silêncio ou ruído de fundo

  // 2. Autocorrelação padrão (sem destruir o buffer)
  var c = new Float32Array(SIZE).fill(0);
  for (var i = 0; i < SIZE; i++) {
    for (var j = 0; j < SIZE - i; j++) {
      c[i] += buf[j] * buf[j + i];
    }
  }

  // 3. Encontrar o primeiro pico real (ignora a descida inicial do sinal)
  var d = 0;
  while (c[d] > c[d + 1]) d++;
  
  var maxval = -1, maxpos = -1;
  for (var i = d; i < SIZE; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }
  var T0 = maxpos;

  // 4. Interpolação Parabólica (aumenta MUITO a precisão dos "cents")
  var x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
  var a = (x1 + x3 - 2 * x2) / 2;
  var b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);

  return sampleRate / T0;
}

function getNoteData(freq) {
  var n = Math.round(12 * Math.log2(freq / 440)) + 69;
  var perfect = 440 * Math.pow(2, (n - 69) / 12);
  var cents = Math.round(1200 * Math.log2(freq / perfect));
  return {
    note: NOTE_NAMES[((n % 12) + 12) % 12],
    octave: Math.floor(n / 12) - 1,
    cents: cents
  };
}

function detectPitch() {
  if (!tunerRunning) return;
  tunerAnalyser.getFloatTimeDomainData(tunerData);
  var f = autoCorrelate(tunerData, tunerCtx.sampleRate);

  if (f > 30 && f < 5000) {
    var nd = getNoteData(f);
    var inTune = Math.abs(nd.cents) < 5;

    $("note").textContent = nd.note;
    $("note").className = "note-big" + (inTune ? " intune" : "");
    $("octave").textContent = "Oitava " + nd.octave;
    $("freq").textContent = f.toFixed(1) + " Hz";

    var pct = ((Math.max(-50, Math.min(50, nd.cents)) + 50) / 100) * 100;
    $("needle").style.left = pct + "%";
    $("needle").style.background = inTune ? "#00ff66" : "#ef4444";

    var centsEl = $("cents");
    if (inTune) {
      centsEl.textContent = "Afinado!";
      centsEl.className = "cents-text intune";
    } else {
      centsEl.textContent = (nd.cents > 0 ? "+" : "") + nd.cents + " cents";
      centsEl.className = "cents-text";
    }
  }

  tunerRAF = requestAnimationFrame(detectPitch);
}

$("tunerBtn").onclick = async function() {
  if (tunerRunning) { stopTuner(); return; }
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tunerCtx = new AudioContext();
    var source = tunerCtx.createMediaStreamSource(stream);
    tunerAnalyser = tunerCtx.createAnalyser();
    tunerAnalyser.fftSize = 4096;
    source.connect(tunerAnalyser);
    tunerData = new Float32Array(tunerAnalyser.fftSize);
    tunerRunning = true;
    $("tunerBtn").textContent = "⏹ Parar Afinador";
    $("tunerBtn").classList.add("danger");
    detectPitch();
  } catch(e) {
    alert("Erro: permissão de microfone negada");
  }
};

function stopTuner() {
  tunerRunning = false;
  if (tunerRAF) cancelAnimationFrame(tunerRAF);
  if (tunerCtx) tunerCtx.close();
  tunerCtx = null;
  tunerAnalyser = null;
  tunerData = null;
  tunerRAF = null;
  $("tunerBtn").textContent = "🎯 Iniciar Afinador";
  $("tunerBtn").classList.remove("danger");
  $("note").textContent = "--";
  $("note").className = "note-big";
  $("octave").textContent = "";
  $("freq").textContent = "";
  $("needle").style.left = "50%";
  $("needle").style.background = "#555";
  $("cents").textContent = "Aguardando sinal de áudio...";
  $("cents").className = "cents-text";
}