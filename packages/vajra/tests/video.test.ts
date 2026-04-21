import { describe, test, expect } from 'bun:test';
import { srtToVtt, DEFAULT_LADDER, detectGPU } from '../src/video';

describe('Video Module', () => {
  test('converts SRT to VTT', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello World

2
00:00:05,000 --> 00:00:08,000
Second subtitle`;

    const vtt = srtToVtt(srt);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:01.000 --> 00:00:04.000');
    expect(vtt).toContain('Hello World');
    expect(vtt).not.toContain(',000'); // Commas should be replaced with dots
  });

  test('SRT to VTT handles CRLF', () => {
    const srt = "1\r\n00:00:01,500 --> 00:00:03,500\r\nTest\r\n";
    const vtt = srtToVtt(srt);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:01.500');
  });

  test('DEFAULT_LADDER has 4 quality presets', () => {
    expect(DEFAULT_LADDER).toHaveLength(4);
    expect(DEFAULT_LADDER[0].name).toBe('360p');
    expect(DEFAULT_LADDER[3].name).toBe('1080p');
  });

  test('quality presets have correct resolutions', () => {
    expect(DEFAULT_LADDER[0].width).toBe(640);
    expect(DEFAULT_LADDER[0].height).toBe(360);
    expect(DEFAULT_LADDER[2].width).toBe(1280);
    expect(DEFAULT_LADDER[2].height).toBe(720);
    expect(DEFAULT_LADDER[3].width).toBe(1920);
    expect(DEFAULT_LADDER[3].height).toBe(1080);
  });

  test('detectGPU returns capabilities', async () => {
    const gpu = await detectGPU();
    expect(gpu).toHaveProperty('nvenc');
    expect(gpu).toHaveProperty('qsv');
    expect(gpu).toHaveProperty('vaapi');
    expect(gpu).toHaveProperty('encoder');
    expect(typeof gpu.encoder).toBe('string');
  });
});
