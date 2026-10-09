import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildChildEnv } from "../src/env-utils.ts";
import { validateSpeechWav } from "../src/speech-service.ts";

/** Actual production Swift helper + AVAudioConverter on macOS; no simulator/device installation. */
test("iOS audio helper converts stereo 48 kHz input to the server canonical PCM16 WAV", {
  skip: process.platform !== "darwin" || process.env.WAND_IOS_SPEECH_AUDIO !== "1", timeout: 120_000,
}, () => {
  const original = readFileSync(new URL("../ios/Wand/ServerSpeechRecorder.swift", import.meta.url), "utf8");
  const start = original.indexOf("enum SpeechWav {"), end = original.indexOf("/// Server batch speech");
  assert.ok(start >= 0 && end > start);
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-ios-speech-"));
  try {
    const source = path.join(root, "main.swift"), executable = path.join(root, "verify"), wavFile = path.join(root, "native.wav");
    writeFileSync(source, "import Foundation\n@preconcurrency import AVFoundation\n" + original.slice(start, end) + `
      let rate = Double(CommandLine.arguments[2])!, channels = Int(CommandLine.arguments[3])!, chunk = Int(CommandLine.arguments[4])!
      let frames = Int(rate / 4)
      let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: AVAudioChannelCount(channels), interleaved: false)!
      private let audio = ServerSpeechAudioBuffer(source: format)!
      var offset = 0
      while offset < frames {
        let count = min(chunk, frames - offset)
        let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
        input.frameLength = AVAudioFrameCount(count)
        for channel in 0..<channels { for frame in 0..<count { input.floatChannelData![channel][frame] = Float(sin(Double(frame + offset) * 2 * Double.pi * 400 / rate) * 0.4) } }
        precondition(audio.append(input)); offset += count
      }
      try audio.wav().write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
      for count in [0, 100, 3201, SpeechWav.maxPCMBytes + 2] {
        do { _ = try SpeechWav.encode(Data(repeating: 0, count: count)); fatalError("Accepted invalid recording") } catch { }
      }
    `);
    const compile = spawnSync("swiftc", [source, "-o", executable], { env: buildChildEnv(true), encoding: "utf8", timeout: 90_000 });
    assert.equal(compile.status, 0, compile.stderr);
    const evidence: unknown[] = [];
    for (const [rate, channels, chunk] of [[48000, 2, 12000], [48000, 2, 1024], [44100, 1, 1024], [16000, 1, 1024]]) {
      const run = spawnSync(executable, [wavFile, String(rate), String(channels), String(chunk)], { env: buildChildEnv(false), encoding: "utf8", timeout: 10_000 });
      assert.equal(run.status, 0, run.stderr);
      const wav = readFileSync(wavFile), result = validateSpeechWav(wav);
      assert.equal(result.silent, false); assert.equal(result.samples, 4000, `Lost tail for ${rate} Hz / ${chunk}-frame chunks`);
      evidence.push({ sourceSampleRate: rate, sourceChannels: channels, sourceChunkFrames: chunk, wavBytes: wav.length, samples: result.samples });
    }
    writeFileSync("output/server-speech/ios-audio-evidence.json", JSON.stringify({ actualSwiftAVAudioConverter: true, hardwareMicrophone: false,
      productionHelper: "ServerSpeechAudioBuffer / SpeechWav", cases: evidence }, null, 2));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
