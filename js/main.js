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
const speedAnnouncer = document.getElementById("speed-announcer");
const pitchResetButton = document.getElementById("pitch-reset");
const seekBar = document.getElementById("seek-bar");
const currentTimeText = document.getElementById("current-time");
const durationText = document.getElementById("duration");
const tonearmArm = document.getElementById("tonearm-arm");
const turntable = document.querySelector(".turntable");
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
      setSeekEnabled(false);
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
  resetPosition(); // 曲の長さが分かるまで、時間表示とシークバーを初期状態に戻す

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
  setSeekEnabled(false);
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
  const speedText = (rate * 100).toFixed(1) + "%";
  pitchValue.textContent = formatPitch(pitch);
  speedDisplay.textContent = speedText;
  // スクリーンリーダーには、スライダーを動かしたときに「+1.5%、速度 101.5%」と1回だけ読ませる
  pitchSlider.setAttribute("aria-valuetext", formatPitch(pitch) + "、速度 " + speedText);
}

// スライダー以外で速度が変わったとき（回転数・「0に戻す」）に、新しい速度を読み上げる
function announceSpeed() {
  speedAnnouncer.textContent = "速度 " + speedDisplay.textContent;
}

// 回転数のラジオが切り替わったとき
speedModeRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    updateSpeed();
    announceSpeed();
  });
});

// フェーダーのキー操作
// 縦向きのスライダーは、キーとつまみの動く向きがブラウザによって違うことがある
// （例：Chrome では PageDown でつまみが上へ動く）。
// そこで、つまみが下へ動く（＋方向）キーと上へ動く（−方向）キーを自分で決めて、どのブラウザでも同じ動きにする。
pitchSlider.addEventListener("keydown", (event) => {
  let pitch = Number(pitchSlider.value);

  if (event.key === "ArrowDown") {
    pitch += 0.1;          // 下へ（＋方向）0.1%
  } else if (event.key === "ArrowUp") {
    pitch -= 0.1;          // 上へ（−方向）0.1%
  } else if (event.key === "PageDown") {
    pitch += 1;            // 下へ 1%
  } else if (event.key === "PageUp") {
    pitch -= 1;            // 上へ 1%
  } else if (event.key === "End") {
    pitch = 8;             // 一番下（+8%）
  } else if (event.key === "Home") {
    pitch = -8;            // 一番上（−8%）
  } else {
    return;                // それ以外のキー（← → など）は、ブラウザ標準の動きに任せる
  }

  event.preventDefault();  // ブラウザ標準の動きを止める（二重に動かないように）

  // 0.1 を足し引きすると 0.30000000000000004 のような誤差が出るので、小数第1位に丸める
  // そのうえで −8〜+8 の範囲に収める
  pitch = Math.round(pitch * 10) / 10;
  pitch = Math.min(8, Math.max(-8, pitch));

  pitchSlider.value = String(pitch);
  updateSpeed(); // value を書き換えても input イベントは起きないので、自分で呼ぶ
});

// 「0に戻す」を押したとき
pitchResetButton.addEventListener("click", () => {
  pitchSlider.value = "0";
  updateSpeed();
  announceSpeed();
});

// ピッチのスライダーを動かしている間（input は動かすたびに起きる）
pitchSlider.addEventListener("input", updateSpeed);

// 最初の表示を整える（ブラウザが前回の選択を復元している場合にも合わせるため）
updateSpeed();

// ===== 再生位置（経過時間・シークバー） =====
// シークバーをドラッグしている間は true（その間は再生位置でつまみを動かさない）
let isDraggingSeekBar = false;

// 秒を "1:23" の形にする（曲の長さが分からないうちは 0 として扱う）
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) {
    seconds = 0;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.floor(seconds % 60);
  return minutes + ":" + String(restSeconds).padStart(2, "0"); // 秒は2桁にそろえる（例：1:05）
}

// 秒を、読み上げ用に "1分23秒" の形にする
function formatTimeForSpeech(seconds) {
  if (!Number.isFinite(seconds)) {
    seconds = 0;
  }
  return Math.floor(seconds / 60) + "分" + Math.floor(seconds % 60) + "秒";
}

// ===== トーンアーム =====
// アームの角度（度）。27.4 で針先が一番外側の溝（中心から 44）、45.5 で一番内側の溝（中心から 22）に来る
// （台座の直径を 100 とした SVG の座標で、針先とレコードの中心の距離から計算した値。
//   内側は、ヘッドシェルがラベル（半径 約16.6）にかからない位置にしている）
const TONEARM_START_ANGLE = 27.4;
const TONEARM_END_ANGLE = 45.5;

// 再生の進み具合（0〜1）に合わせて、アームを回す
// 曲の始め（0）は外側、終わり（1）は内側
function updateTonearm(progress) {
  const angle = TONEARM_START_ANGLE + (TONEARM_END_ANGLE - TONEARM_START_ANGLE) * progress;
  // SVG の transform：支点 (116, 16) へ移動してから、angle 度回す
  tonearmArm.setAttribute("transform", "translate(116 16) rotate(" + angle + ")");
}

// 今の再生位置を、時間表示・シークバー・トーンアームに反映する
function updatePosition() {
  currentTimeText.textContent = formatTime(audio.currentTime);
  // ドラッグ中につまみを書き換えると、つまみが指から逃げてしまうので書き換えない
  if (!isDraggingSeekBar) {
    seekBar.value = audio.currentTime;
  }
  seekBar.setAttribute("aria-valuetext",
    formatTimeForSpeech(audio.currentTime) + " / " + formatTimeForSpeech(audio.duration));

  // 進み具合 = 再生位置 ÷ 曲の長さ（長さが分からないうちは 0）
  const progress = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
  updateTonearm(progress);
}

// 再生位置を操作できるかどうかを切り替える（シークバーと、レコードのクリック＝ニードルドロップ）
function setSeekEnabled(enabled) {
  seekBar.disabled = !enabled;
  // 操作できるときだけ、レコードの上でカーソルを指の形にする（CSS の .is-ready）
  turntable.classList.toggle("is-ready", enabled);
}

// 新しい曲を読み込んだときに、時間表示とシークバーを初期状態に戻す
function resetPosition() {
  setSeekEnabled(false); // 曲の長さが分かるまでは操作できない
  seekBar.max = 0;
  seekBar.value = 0;
  durationText.textContent = formatTime(0);
  currentTimeText.textContent = formatTime(0);
  updateTonearm(0); // アームを一番外側に戻す
}

// 曲の長さが分かったとき（loadedmetadata）
audio.addEventListener("loadedmetadata", () => {
  seekBar.max = audio.duration;
  setSeekEnabled(true);
  durationText.textContent = formatTime(audio.duration);
  updatePosition();
});

// ===== ニードルドロップ（レコードをクリックした位置から再生） =====
// 針を落とせる範囲（中心からの距離。台座の直径を 100 とした値で、トーンアームと同じ）
const GROOVE_OUTER_RADIUS = 44; // 一番外側の溝（曲の始め）
const GROOVE_INNER_RADIUS = 22; // 一番内側の溝（曲の終わり）

turntable.addEventListener("click", (event) => {
  // 曲を読み込む前（シークバーが押せないとき）は何もしない
  if (seekBar.disabled) {
    return;
  }

  // 台座の中心を求める
  // （回転しているレコードではなく、回らない台座で測る。
  //   回っている要素の四角い範囲は、角度によって大きさが変わってしまうため）
  const rect = turntable.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  // クリックした位置と中心の距離を、「台座の直径 = 100」の単位に直す
  const distance = Math.hypot(event.clientX - centerX, event.clientY - centerY);
  const radius = (distance / rect.width) * 100;

  // 溝の範囲の外（ラベルや外側の縁）は無視する
  if (radius > GROOVE_OUTER_RADIUS || radius < GROOVE_INNER_RADIUS) {
    return;
  }

  // 外側ほど曲の始め、内側ほど曲の終わり
  // 進み具合 =（外側の半径 − クリックした半径）÷（外側の半径 − 内側の半径）
  const progress = (GROOVE_OUTER_RADIUS - radius) / (GROOVE_OUTER_RADIUS - GROOVE_INNER_RADIUS);
  audio.currentTime = progress * audio.duration;
});

// 再生位置が進んだとき（再生中は1秒に4回ほど起きる。シークしたときも起きる）
audio.addEventListener("timeupdate", updatePosition);

// シークバーを動かしたとき（ドラッグ中もキー操作でも起きる）
seekBar.addEventListener("input", () => {
  audio.currentTime = Number(seekBar.value);
  currentTimeText.textContent = formatTime(audio.currentTime);
});

// シークバーを押したらドラッグ中、離したらドラッグ終わり
// （シークバーの外で指を離すこともあるので、離したことは画面全体で受け取る）
seekBar.addEventListener("pointerdown", () => {
  isDraggingSeekBar = true;
});
window.addEventListener("pointerup", () => {
  isDraggingSeekBar = false;
});
window.addEventListener("pointercancel", () => {
  isDraggingSeekBar = false;
});

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
