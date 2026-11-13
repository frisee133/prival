// Detection sees the current block; playback reads a 20 ms ring buffer so the
// gate opens before the attack of the first speech block reaches the output.
class VoiceGate extends AudioWorkletProcessor {
  constructor({ processorOptions: p }) {
    super();
    this.openLevel = 10 ** (p.threshold / 20);
    this.closeLevel = this.openLevel * 10 ** (-4 / 20);
    this.holdSamples = Math.round((sampleRate * p.holdMs) / 1000);
    this.buffer = new Float32Array(
      Math.max(1, Math.round((sampleRate * p.lookaheadMs) / 1000)),
    );
    this.position = 0;
    this.hold = 0;
    this.gain = 0;
    this.attack = 1 / (sampleRate * 0.005);
    this.release = 1 / (sampleRate * 0.03);
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0],
      output = outputs[0]?.[0];
    if (!output) return true;
    let energy = 0;
    if (input) for (const value of input) energy += value * value;
    const level = Math.sqrt(energy / (input?.length || output.length));
    if (level >= (this.hold > 0 ? this.closeLevel : this.openLevel))
      this.hold = this.holdSamples + this.buffer.length;
    for (let i = 0; i < output.length; i++) {
      const open = this.hold > 0;
      this.hold = Math.max(0, this.hold - 1);
      this.gain = open
        ? Math.min(1, this.gain + this.attack)
        : Math.max(0, this.gain - this.release);
      output[i] = this.buffer[this.position] * this.gain;
      this.buffer[this.position] = input?.[i] || 0;
      this.position = (this.position + 1) % this.buffer.length;
    }
    return true;
  }
}
registerProcessor("prival-voice-gate", VoiceGate);
