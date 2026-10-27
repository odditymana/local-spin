// js/aiff-to-wav.js のテスト
//
// 実行方法（Node.js 18 以降。プロジェクトのフォルダで）：
//   node --test
// （*.test.js という名前のファイルを自動で探して実行する）
//
// テスト用の音は、このスクリプトの中でサイン波を作って使う（音源ファイルは使わない）。
// 同じサイン波から「AIFF」と「正解の WAV」をそれぞれ組み立て、
// aiffToWav() の出力が正解の WAV と1バイトも違わないことを確かめる。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ===== テスト対象を読み込む =====
// aiff-to-wav.js はブラウザ用の普通のスクリプトなので、vm（Node の中で別の実行環境を作る機能）で読み込む
const context = vm.createContext({ Blob, Error, Math, DataView, ArrayBuffer, Uint8Array, String });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/aiff-to-wav.js"), "utf8"), context);
const aiffToWav = context.aiffToWav;

// ===== テスト用の音を作る =====
// サイン波のサンプル（-1〜1 の数値）を、指定のビット数の整数にした配列を返す
// 並びは [フレーム0のch1, フレーム0のch2, フレーム1のch1, …]
function makeSineSamples(channels, frames, bitsPerSample) {
  const max = 2 ** (bitsPerSample - 1) - 1; // 例：16bit なら 32767
  const samples = [];
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      // チャンネルごとに周波数を変えて、左右の取り違えにも気づけるようにする
      samples.push(Math.round(Math.sin(i * 0.05 * (ch + 1)) * max * 0.9));
    }
  }
  return samples;
}

// 整数のサンプルをバイト列にする（littleEndian が true なら小さい桁が先）
function samplesToBytes(samples, bytesPerSample, littleEndian) {
  const bytes = [];
  for (const sample of samples) {
    const sampleBytes = [];
    for (let j = 0; j < bytesPerSample; j++) {
      // 下の桁から1バイトずつ取り出す（負の数も & 0xff で2の補数のバイトになる）
      sampleBytes.push((sample >> (8 * j)) & 0xff);
    }
    if (!littleEndian) {
      sampleBytes.reverse();
    }
    bytes.push(...sampleBytes);
  }
  return bytes;
}

// ===== AIFF を組み立てる =====
// 整数のサンプルレートを 80bit 拡張浮動小数点数にする（テスト側の独立した実装）
function encodeExtendedFloat(view, offset, value) {
  const exponent = Math.floor(Math.log2(value)); // 2 の何乗か
  view.setUint16(offset, exponent + 16383);
  // 仮数「1.xxx」を、先頭bitが一番上に来る 64bit の整数として書く
  view.setBigUint64(offset + 2, BigInt(value) << BigInt(63 - exponent));
}

// 名前とバイト列からチャンクを作る（サイズが奇数なら詰め物を1バイト足す）
function makeChunk(name, bytes) {
  const header = Buffer.alloc(8);
  header.write(name, 0, "latin1");
  header.writeUInt32BE(bytes.length, 4);
  const padding = bytes.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, Buffer.from(bytes), padding]);
}

// AIFF / AIFF-C のファイルを作り、ArrayBuffer で返す
// options.compression を指定すると AIFF-C になる（"NONE"・"sowt" など）
function makeAiff({ channels, sampleRate, bitsPerSample, samples, compression, extraChunk, ssndFirst }) {
  const isAifc = compression !== undefined;
  const bytesPerSample = Math.ceil(bitsPerSample / 8);

  // COMM：チャンネル数・サンプル数・ビット数・サンプルレート（＋ AIFF-C は圧縮形式）
  const comm = Buffer.alloc(isAifc ? 24 : 18);
  const commView = new DataView(comm.buffer, comm.byteOffset, comm.length);
  comm.writeUInt16BE(channels, 0);
  comm.writeUInt32BE(samples.length / channels, 2);
  comm.writeUInt16BE(bitsPerSample, 6);
  encodeExtendedFloat(commView, 8, sampleRate);
  if (isAifc) {
    comm.write(compression, 18, "latin1");
    // 18〜21：圧縮形式、22〜23：圧縮形式の名前（空の文字列＋詰め物）
  }

  // SSND：余白(offset)・ブロックサイズ・音のデータ
  const littleEndian = compression === "sowt";
  const ssnd = [0, 0, 0, 0, 0, 0, 0, 0, ...samplesToBytes(samples, bytesPerSample, littleEndian)];

  const chunks = [makeChunk("COMM", comm)];
  if (extraChunk) {
    chunks.push(extraChunk);
  }
  chunks.push(makeChunk("SSND", ssnd));
  if (ssndFirst) {
    chunks.reverse();
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("FORM", 0, "latin1");
  header.writeUInt32BE(4 + body.length, 4);
  header.write(isAifc ? "AIFC" : "AIFF", 8, "latin1");

  const file = Buffer.concat([header, body]);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.length);
}

// ===== 正解の WAV を組み立てる =====
function makeExpectedWav({ channels, sampleRate, bitsPerSample, samples }) {
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  let data = samplesToBytes(samples, bytesPerSample, true);
  if (bytesPerSample === 1) {
    // WAV の 8bit は符号なし（0〜255）
    data = samples.map((sample) => sample + 128);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, Buffer.from(data)]);
}

// aiffToWav() の結果（Blob）をバイト列にする
async function convert(arrayBuffer) {
  const blob = aiffToWav(arrayBuffer);
  assert.strictEqual(blob.type, "audio/wav");
  return Buffer.from(await blob.arrayBuffer());
}

// ===== 正しく変換できる形式 =====
const validCases = [
  { name: "AIFF 16bit ステレオ 44.1kHz", channels: 2, sampleRate: 44100, bitsPerSample: 16 },
  { name: "AIFF 24bit ステレオ 44.1kHz", channels: 2, sampleRate: 44100, bitsPerSample: 24 },
  { name: "AIFF 8bit モノラル 22.05kHz", channels: 1, sampleRate: 22050, bitsPerSample: 8 },
  { name: "AIFF 16bit ステレオ 48kHz", channels: 2, sampleRate: 48000, bitsPerSample: 16 },
  { name: "AIFF 32bit ステレオ 96kHz", channels: 2, sampleRate: 96000, bitsPerSample: 32 },
  { name: "AIFF-C NONE 16bit", channels: 2, sampleRate: 44100, bitsPerSample: 16, compression: "NONE" },
  { name: "AIFF-C sowt 16bit", channels: 2, sampleRate: 44100, bitsPerSample: 16, compression: "sowt" },
  { name: "AIFF-C sowt 24bit", channels: 2, sampleRate: 44100, bitsPerSample: 24, compression: "sowt" },
  // ほかのチャンク（サイズが奇数）が間にあっても、詰め物を考えて読み飛ばせるか
  { name: "奇数サイズのチャンクを含む AIFF", channels: 2, sampleRate: 44100, bitsPerSample: 16,
    extraChunk: makeChunk("NAME", Buffer.from("odd")) },
  // SSND が COMM より先にあっても読めるか
  { name: "SSND が COMM より先にある AIFF", channels: 2, sampleRate: 44100, bitsPerSample: 16, ssndFirst: true },
];

for (const testCase of validCases) {
  test(testCase.name + " を WAV に変換できる", async () => {
    const samples = makeSineSamples(testCase.channels, 1000, testCase.bitsPerSample);
    const input = { ...testCase, samples };
    const wav = await convert(makeAiff(input));
    assert.deepStrictEqual(wav, makeExpectedWav(input));
  });
}

// ===== エラーになるべき形式 =====
test("対応していない AIFF-C（ulaw）はエラーになる", () => {
  const samples = makeSineSamples(1, 100, 8);
  const aiff = makeAiff({ channels: 1, sampleRate: 8000, bitsPerSample: 8, samples, compression: "ulaw" });
  assert.throws(() => aiffToWav(aiff), /ulaw/);
});

test("AIFF ではないファイル（WAV）はエラーになる", () => {
  const samples = makeSineSamples(1, 100, 16);
  const wav = makeExpectedWav({ channels: 1, sampleRate: 44100, bitsPerSample: 16, samples });
  assert.throws(() => aiffToWav(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length)), /AIFF ファイルとして読み込めません/);
});

test("途中で切れた AIFF は、残っているぶんだけ変換する", async () => {
  const samples = makeSineSamples(2, 1000, 16);
  const input = { channels: 2, sampleRate: 44100, bitsPerSample: 16, samples };
  const full = makeAiff(input);
  // 末尾の 101 バイトを切り落とす（フレームの途中で切れる長さ）
  const cut = full.slice(0, full.byteLength - 101);
  const wav = await convert(cut);
  // 残ったフレームぶん（途中で切れた最後のフレームは捨てる）だけの正解と比べる
  const remainingFrames = Math.floor((1000 * 4 - 101) / 4);
  const expected = makeExpectedWav({ ...input, samples: samples.slice(0, remainingFrames * 2) });
  assert.deepStrictEqual(wav, expected);
});
