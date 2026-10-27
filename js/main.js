// LOCAL SPIN の動き
// 音源はブラウザ内だけで扱い、外部には一切送信しない。

// ===== 画面の部品を取得 =====
const audio = document.getElementById("audio");
const fileInput = document.getElementById("file-input");
const fileName = document.getElementById("file-name");
const playButton = document.getElementById("play-button");
const message = document.getElementById("message");
const speedModeRadios = document.querySelectorAll('input[name="speed-mode"]');
const pitchSlider = document.getElementById("pitch-slider");
const pitchValue = document.getElementById("pitch-value");
const speedDisplay = document.getElementById("speed-display");
const record = document.querySelector(".record");

// 今読み込んでいる曲のURL（次の曲を読み込むときに解放するため保存しておく）
let currentUrl = null;

// 読み込みの通し番号。AIFF の変換を待っている間に別のファイルが読み込まれたら、
// 古いほうの結果を捨てるために使う（最新の番号の読み込みだけを反映する）
let latestLoadNumber = 0;

// 音声ファイルとして受け付ける拡張子の一覧（m4a は AAC・ALAC、oga は Ogg の音声）
const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "aiff", "aif", "aifc", "m4a", "ogg", "oga"];

// WAV に変換してから再生する拡張子（AIFF・AIFF-C）
const AIFF_EXTENSIONS = ["aiff", "aif", "aifc"];

// 回転数ごとの基準速度（33回転を 1.0 とする）
// 33回転は正確には 33⅓回転（= 100 / 3）
const BASE_SPEEDS = {
  "33": 1,
  "45": 45 / (100 / 3),    // 45回転：約1.35倍
  "screw": (100 / 3) / 45, // スクリュー（45回転の盤を33回転で再生）：約0.74倍
};

// ===== ファイル読み込み =====
// 音声ファイルかどうかを判定する
// 種類名（file.type）が audio/ で始まる、または拡張子が一覧にあれば受け付ける
// （種類名が空だったり、.ogg が "video/ogg" になったりするブラウザがあるため両方見る）
function isAudioFile(file) {
  return file.type.startsWith("audio/") || AUDIO_EXTENSIONS.includes(getExtension(file));
}

// ファイル名の拡張子（最後の "." より後ろ）を小文字で返す
function getExtension(file) {
  return file.name.split(".").pop().toLowerCase();
}

// 「ファイルを選ぶ」とドロップの両方から呼ばれる共通の処理
// AIFF の変換でファイルの中身を読むのを待つため、async（途中で待てる関数）にしている
async function loadFile(file) {
  // この読み込みに番号を振る
  latestLoadNumber += 1;
  const loadNumber = latestLoadNumber;

  if (!isAudioFile(file)) {
    fileName.textContent = "音声ファイルを選んでください（" + file.name + " は読み込めません）";
    return;
  }

  // audio に渡すもの。ふつうは選ばれたファイルそのもの
  let source = file;

  // AIFF は、ブラウザ内で WAV に変換してから渡す（変換の中身は aiff-to-wav.js）
  if (AIFF_EXTENSIONS.includes(getExtension(file))) {
    fileName.textContent = file.name + "（WAV に変換中…）";
    try {
      const arrayBuffer = await file.arrayBuffer(); // ファイルの中身をバイト列として読む
      // 待っている間に別のファイルが読み込まれていたら、この結果は捨てる
      if (loadNumber !== latestLoadNumber) {
        return;
      }
      source = aiffToWav(arrayBuffer);
    } catch (error) {
      // 失敗した場合も、すでに新しい読み込みがあれば何もしない
      if (loadNumber !== latestLoadNumber) {
        return;
      }
      // 変換できなかったときは理由を表示し、再生できない状態にする
      audio.pause();
      fileName.textContent = file.name;
      message.textContent = error.message;
      playButton.disabled = true;
      return;
    }
  }

  // 前の曲のURLを解放する（メモリの後片付け）
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
  }

  // 手元のファイルに、このブラウザの中だけで使えるURLを付けて audio に渡す
  // （アップロードではないので、外部には送信されない）
  currentUrl = URL.createObjectURL(source);
  audio.src = currentUrl;

  // 曲名を表示し、前のエラーを消して、再生ボタンを押せるようにする
  fileName.textContent = file.name;
  message.textContent = "";
  playButton.disabled = false;
}

// 「ファイルを選ぶ」で選ばれたとき
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) {
    loadFile(file);
  }
  // 選択を空に戻す（同じファイルを選び直しても change が起きるようにするため）
  fileInput.value = "";
});

// ===== ドラッグ＆ドロップ（画面全体で受け付ける） =====
// dragenter・dragleave は、画面の中の部品の上を通るたびに起きる。
// そのたびに表示を消すとちらつくので、「入った回数 − 出た回数」を数え、0 になったときだけ消す。
let dragDepth = 0;

// ドラッグしているのがファイルかどうか（ページ内の文字を選んでドラッグした場合などは除く）
function isFileDrag(event) {
  return event.dataTransfer.types.includes("Files");
}

window.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) {
    return;
  }
  dragDepth += 1;
  document.body.classList.add("is-dragging"); // 画面全体に「ドロップして読み込む」を出す
});

window.addEventListener("dragleave", (event) => {
  if (!isFileDrag(event)) {
    return;
  }
  dragDepth -= 1;
  if (dragDepth === 0) {
    document.body.classList.remove("is-dragging");
  }
});

// ファイルが上にある間
window.addEventListener("dragover", (event) => {
  event.preventDefault(); // これがないとドロップを受け付けない
});

// ファイルが落とされたとき
window.addEventListener("drop", (event) => {
  event.preventDefault(); // ブラウザがファイルを開いて画面が切り替わるのを防ぐ
  dragDepth = 0;
  document.body.classList.remove("is-dragging");

  const file = event.dataTransfer.files[0];
  if (file) {
    loadFile(file);
  }
});

// ===== 再生／停止 =====
// エラーメッセージを表示し、再生ボタンを押せなくする
function showPlaybackError() {
  // 例：ALAC（.m4a）は Safari 以外では再生できないので、ここで案内する
  message.textContent = "この形式はこのブラウザで再生できません。FLAC などをお試しください。";
  playButton.disabled = true;
}

// ボタンを押したら、止まっていれば再生、再生中なら停止（一時停止）する
playButton.addEventListener("click", async () => {
  if (audio.paused) {
    try {
      // play() は Promise（あとで成功か失敗かが決まる値）を返すので、await で結果を待つ
      await audio.play();
    } catch (error) {
      // 再生開始前に停止を押した場合も失敗扱いになるが、これはエラーではないので無視する
      if (error.name === "AbortError") {
        return;
      }
      showPlaybackError();
    }
  } else {
    audio.pause();
  }
});

// ボタンの文字を、audio の実際の状態に合わせる
function updatePlayButton() {
  playButton.textContent = audio.paused ? "再生" : "停止";
}

// 再生が始まった／止まった／最後まで流れたときに、ボタンの文字を更新する
audio.addEventListener("play", updatePlayButton);
audio.addEventListener("pause", updatePlayButton);
audio.addEventListener("ended", updatePlayButton);

// ファイルの読み込み（デコード）に失敗したとき
audio.addEventListener("error", showPlaybackError);

// ===== 速度（回転数とピッチ） =====
// 速度を変えると音の高さも変わるようにする（レコードと同じ動き）
// 古い Safari 用（webkit）・古い Firefox 用（moz）の名前もあわせて設定する
audio.preservesPitch = false;
audio.webkitPreservesPitch = false;
audio.mozPreservesPitch = false;

// 数値に符号を付けて "+1.5%" のような文字にする（0 のときは "0.0%"）
function formatPitch(pitch) {
  const sign = pitch > 0 ? "+" : "";
  return sign + pitch.toFixed(1) + "%";
}

// 回転数とピッチから速度を計算し、audio と画面に反映する
// 回転数やピッチが変わるたびに、この関数を呼ぶ
function updateSpeed() {
  // 選ばれている回転数（"33" / "45" / "screw"）
  const mode = document.querySelector('input[name="speed-mode"]:checked').value;
  // ピッチ（-8 〜 +8 の数値。スライダーの値は文字列なので Number で数値にする）
  const pitch = Number(pitchSlider.value);

  // 速度 = 基準速度 ×（1 + ピッチ% ÷ 100）
  const rate = BASE_SPEEDS[mode] * (1 + pitch / 100);

  // playbackRate：今の再生速度
  // defaultPlaybackRate：新しい曲を読み込んだときに使われる速度
  // （これも設定しないと、曲を読み込むたびに速度が 1.0 に戻ってしまう）
  audio.playbackRate = rate;
  audio.defaultPlaybackRate = rate;

  // 画面の表示を更新する
  pitchValue.textContent = formatPitch(pitch);
  pitchSlider.setAttribute("aria-valuetext", formatPitch(pitch)); // スクリーンリーダーに "+1.5%" と読ませる
  speedDisplay.textContent = (rate * 100).toFixed(1) + "%";
}

// 回転数のラジオが切り替わったとき
speedModeRadios.forEach((radio) => {
  radio.addEventListener("change", updateSpeed);
});

// ピッチのスライダーを動かしている間（input は動かすたびに起きる）
pitchSlider.addEventListener("input", updateSpeed);

// 最初の表示を整える（ブラウザが前回の選択を復元している場合にも合わせるため）
updateSpeed();

// ===== 回転するレコード =====
// 33⅓回転のレコードは 1分（60秒）で 33⅓周 する → 1周 1.8秒
const SECONDS_PER_TURN = 60 / (100 / 3);

// OS の「動きを減らす」設定（prefers-reduced-motion）を調べるためのもの
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let angle = 0;           // 今のレコードの角度（0〜360度）
let lastTime = null;     // 前回描いたときの時刻（ミリ秒）
let animationId = null;  // 回転中のときの requestAnimationFrame の番号（止めるときに使う）

// 画面を描き直すたびに呼ばれ、経過時間ぶんだけ角度を進める
// （time は requestAnimationFrame が渡してくれる、今の時刻）
function rotateRecord(time) {
  if (lastTime !== null) {
    const elapsedSeconds = (time - lastTime) / 1000;
    // 1秒あたりの角度 = 360度 ÷ 1周の秒数 × 再生速度
    const degreesPerSecond = (360 / SECONDS_PER_TURN) * audio.playbackRate;
    // 角度を足し、% 360 で 0〜360 の範囲に収める
    angle = (angle + degreesPerSecond * elapsedSeconds) % 360;
    record.style.transform = "rotate(" + angle + "deg)";
  }
  lastTime = time;
  // 次に画面を描き直すときにも、この関数を呼んでもらう
  animationId = requestAnimationFrame(rotateRecord);
}

// 回転を始める（すでに回っている・動きを減らす設定・停止中のときは何もしない）
function startRotation() {
  if (animationId !== null || reducedMotion.matches || audio.paused) {
    return;
  }
  lastTime = null; // 止まっていた時間を経過時間に含めないよう、測り直す
  animationId = requestAnimationFrame(rotateRecord);
}

// 回転を止める（角度はそのまま残るので、次は同じ角度から回り出す）
function stopRotation() {
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
}

// 音が実際に鳴り始めたら回し、止まったら止める
audio.addEventListener("playing", startRotation);
audio.addEventListener("pause", stopRotation);
audio.addEventListener("ended", stopRotation);

// 再生中に「動きを減らす」設定が切り替わったら、その場で止める／回し直す
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) {
    stopRotation();
  } else {
    startRotation();
  }
});
