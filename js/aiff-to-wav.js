// AIFF → WAV 変換
// Chrome・Firefox は AIFF を再生できないため、ブラウザ内でバイナリ（ファイルの中身のバイト列）を読み、
// WAV に作り直して audio に渡す。変換はすべてこの端末の中で行い、外部には送信しない。
//
// 対応する形式：
//   AIFF（非圧縮）、AIFF-C の "NONE"・"twos"（AIFF と同じ並び）と "sowt"（バイトの並びが逆）
//   ビット数は 8〜32bit
// それ以外の AIFF-C（圧縮されたもの・浮動小数点数のもの）はエラーにする。

// AIFF の 80bit 拡張浮動小数点数（サンプルレートの保存形式）を、JavaScript の数値として読む
//
// 80bit（10バイト）の中身：
//   1バイト目の先頭1bit   … 符号（0 ならプラス、1 ならマイナス）
//   続く15bit             … 指数（2 を何乗するか。ただし 16383 を足した値で保存されている）
//   残り64bit（8バイト）  … 仮数（「1.0101…」のような2進数の小数。先頭のbitが小数点の左側）
//
// 値 ＝ 符号 × 仮数（1.xxx）× 2 の（指数 − 16383）乗
//
// JavaScript には 80bit の数値を直接読む機能がないので、部品ごとに読んで自分で計算する。
function readExtendedFloat(view, offset) {
  // 先頭2バイト（16bit）に、符号1bit と指数15bit がまとめて入っている
  const signAndExponent = view.getUint16(offset);
  const sign = (signAndExponent & 0x8000) ? -1 : 1; // 一番上の1bitだけを取り出す
  const exponent = signAndExponent & 0x7fff;        // 下の15bitだけを取り出す

  // 仮数の64bitは一度に読めないので、上位32bitと下位32bitに分けて読む
  const mantissaHigh = view.getUint32(offset + 2);
  const mantissaLow = view.getUint32(offset + 6);

  // 全部 0 なら、値も 0
  if (exponent === 0 && mantissaHigh === 0 && mantissaLow === 0) {
    return 0;
  }

  // 上位と下位をつないで、64bit の整数として仮数を作る（上位 × 2の32乗 ＋ 下位）
  const mantissa = mantissaHigh * 2 ** 32 + mantissaLow;

  // 本来の仮数は「1.xxx」（小数点が先頭bitのすぐ後ろ）だが、
  // 整数として読んだので 2の63乗 倍 大きくなっている。そのぶん指数から 63 を引いて戻す。
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}

// 指定した位置から、4文字の名前（"FORM" や "COMM" など）を読む
function readText(view, offset, length) {
  let text = "";
  for (let i = 0; i < length; i++) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}

// 指定した位置に、4文字の名前を書く
function writeText(view, offset, text) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

// AIFF のバイト列（ArrayBuffer）を受け取り、WAV の Blob を返す
// 対応していない形式のときは、理由をメッセージにした Error を投げる
function aiffToWav(arrayBuffer) {
  // DataView：バイト列から「何バイト目から何bitの数値」を読み書きする道具
  // AIFF はビッグエンディアン（大きい桁が先）で、DataView の標準の読み方もビッグエンディアン
  const view = new DataView(arrayBuffer);

  // ===== 1. 先頭12バイトで、AIFF かどうかを確かめる =====
  // "FORM" ＋ サイズ（4バイト）＋ "AIFF" または "AIFC"
  const formType = readText(view, 8, 4);
  if (readText(view, 0, 4) !== "FORM" || (formType !== "AIFF" && formType !== "AIFC")) {
    throw new Error("AIFF ファイルとして読み込めませんでした。");
  }

  // ===== 2. チャンク（名前・サイズ・中身がセットになった箱）を順に読む =====
  let channels = 0;          // チャンネル数（1 ならモノラル、2 ならステレオ）
  let bitsPerSample = 0;     // 1サンプルのビット数
  let sampleRate = 0;        // 1秒あたりのサンプル数（例：44100）
  let compression = "NONE";  // AIFF-C の圧縮形式（普通の AIFF は "NONE" と同じ扱い）
  let soundStart = -1;       // 音のデータが始まる位置
  let soundLength = 0;       // 音のデータの長さ（バイト）

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkName = readText(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4);
    const dataStart = offset + 8; // チャンクの中身はここから

    if (chunkName === "COMM") {
      // COMM：音の形式（チャンネル数・ビット数・サンプルレート）
      channels = view.getUint16(dataStart);
      // dataStart + 2 からの4バイトはサンプル数（ここでは使わない）
      bitsPerSample = view.getUint16(dataStart + 6);
      sampleRate = readExtendedFloat(view, dataStart + 8);
      // AIFF-C だけ、続けて圧縮形式の4文字がある
      if (formType === "AIFC") {
        compression = readText(view, dataStart + 18, 4);
      }
    } else if (chunkName === "SSND") {
      // SSND：音のデータそのもの
      // 先頭8バイトは「データ開始までの余白」と「ブロックサイズ」。余白のぶん後ろからデータが始まる
      const padding = view.getUint32(dataStart);
      soundStart = dataStart + 8 + padding;
      soundLength = chunkSize - 8 - padding;
    }
    // それ以外のチャンク（曲名など）は読み飛ばす

    // 次のチャンクへ（サイズが奇数のときは 1バイト の詰め物があるので偶数にそろえる）
    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  // ===== 3. 対応できる形式かどうかを確かめる =====
  if (channels === 0 || sampleRate <= 0 || soundStart < 0) {
    throw new Error("AIFF ファイルの中身が足りないため、読み込めませんでした。");
  }

  // "NONE"・"twos" はビッグエンディアン、"sowt" はリトルエンディアン（小さい桁が先）
  let isLittleEndian;
  if (compression === "NONE" || compression === "twos") {
    isLittleEndian = false;
  } else if (compression === "sowt") {
    isLittleEndian = true;
  } else {
    throw new Error("この AIFF-C の形式（" + compression.trim() + "）には対応していません。");
  }

  // 1サンプルのバイト数（例：24bit なら 3バイト。20bit なども切り上げて 3バイトになる）
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  if (bytesPerSample < 1 || bytesPerSample > 4) {
    throw new Error("この AIFF のビット数（" + bitsPerSample + "bit）には対応していません。");
  }

  // ファイルが途中で切れている場合に備えて、実際にあるぶんだけを使う
  // また、全チャンネルぶんそろったサンプル（1フレーム）の倍数にそろえる
  const blockAlign = channels * bytesPerSample; // 1フレームのバイト数
  let dataLength = Math.min(soundLength, view.byteLength - soundStart);
  dataLength -= dataLength % blockAlign;

  // ===== 4. WAV を作る（先頭44バイトのヘッダ ＋ 音のデータ） =====
  const wavBuffer = new ArrayBuffer(44 + dataLength);
  const wavView = new DataView(wavBuffer);

  // WAV のヘッダはリトルエンディアンなので、数値を書くときは最後の引数に true を付ける
  writeText(wavView, 0, "RIFF");
  wavView.setUint32(4, 36 + dataLength, true);                 // これ以降のファイルサイズ
  writeText(wavView, 8, "WAVE");
  writeText(wavView, 12, "fmt ");
  wavView.setUint32(16, 16, true);                             // fmt チャンクの長さ
  wavView.setUint16(20, 1, true);                              // 1 = 非圧縮（PCM）
  wavView.setUint16(22, channels, true);                       // チャンネル数
  wavView.setUint32(24, Math.round(sampleRate), true);         // サンプルレート
  wavView.setUint32(28, Math.round(sampleRate) * blockAlign, true); // 1秒あたりのバイト数
  wavView.setUint16(32, blockAlign, true);                     // 1フレームのバイト数
  wavView.setUint16(34, bytesPerSample * 8, true);             // 1サンプルのビット数
  writeText(wavView, 36, "data");
  wavView.setUint32(40, dataLength, true);                     // 音のデータの長さ

  // 音のデータをコピーする
  const input = new Uint8Array(arrayBuffer, soundStart, dataLength); // AIFF 側
  const output = new Uint8Array(wavBuffer, 44);                      // WAV 側（ヘッダの後ろ）

  for (let i = 0; i < dataLength; i += bytesPerSample) {
    if (bytesPerSample === 1) {
      // 8bit：AIFF は符号付き（-128〜127）、WAV は符号なし（0〜255）なので 128 ずらす
      output[i] = (input[i] + 128) & 0xff;
    } else if (isLittleEndian) {
      // sowt：もともと WAV と同じ並びなので、そのままコピー
      for (let j = 0; j < bytesPerSample; j++) {
        output[i + j] = input[i + j];
      }
    } else {
      // ビッグエンディアン：1サンプルの中でバイトの順番を逆にする
      // 例（16bit）：[上位, 下位] → [下位, 上位]
      for (let j = 0; j < bytesPerSample; j++) {
        output[i + j] = input[i + bytesPerSample - 1 - j];
      }
    }
  }

  // Blob：ブラウザ内で扱えるファイルのようなもの。種類を WAV として返す
  return new Blob([wavBuffer], { type: "audio/wav" });
}
