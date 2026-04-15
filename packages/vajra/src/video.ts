/**
 * Vajra Video Streaming Module
 * Range requests, HLS transcoding, GPU detection, thumbnail extraction.
 * Uses FFmpeg (system binary) for transcoding. No npm dependency.
 *
 * @example
 *   app.use(videoStreamer({ storage: './videos', cache: './cache/video' }));
 *   // GET /videos/movie.mp4 — range request streaming
 *   // GET /videos/movie.mp4/hls/master.m3u8 — HLS playlist
 *   // GET /videos/movie.mp4/thumb/1 — thumbnail
 */

import type { Context } from './context';
import type { Middleware } from './middleware';

/* ═══════ TYPES ═══════ */

interface VideoStreamerOptions {
  /** Video storage directory */
  storage: string;
  /** Cache directory for HLS segments and thumbnails */
  cache: string;
  /** URL prefix. Default: /videos */
  prefix?: string;
  /** Max upload size in bytes. Default: 2GB */
  maxUploadSize?: number;
  /** Max concurrent transcoding jobs. Default: 2 */
  maxConcurrentTranscode?: number;
  /** HLS segment duration in seconds. Default: 6 */
  segmentDuration?: number;
  /** Auto-detect GPU encoder. Default: true */
  autoDetectGPU?: boolean;
}

interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrate: number;
  size: number;
  audioCodec?: string;
  audioChannels?: number;
}

interface TranscodeJob {
  id: string;
  input: string;
  outputDir: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  progress: number;
  error?: string;
  createdAt: number;
}

interface QualityPreset {
  name: string;
  width: number;
  height: number;
  bitrate: string;
  maxrate: string;
  bufsize: string;
  audioBitrate: string;
}

/* ═══════ ENCODING LADDER ═══════ */

const DEFAULT_LADDER: QualityPreset[] = [
  { name: '360p', width: 640, height: 360, bitrate: '800k', maxrate: '856k', bufsize: '1200k', audioBitrate: '96k' },
  { name: '480p', width: 854, height: 480, bitrate: '1400k', maxrate: '1498k', bufsize: '2100k', audioBitrate: '128k' },
  { name: '720p', width: 1280, height: 720, bitrate: '2800k', maxrate: '2996k', bufsize: '4200k', audioBitrate: '128k' },
  { name: '1080p', width: 1920, height: 1080, bitrate: '5000k', maxrate: '5350k', bufsize: '7500k', audioBitrate: '192k' },
];

/* ═══════ GPU DETECTION ═══════ */

interface GPUCapabilities {
  nvenc: boolean;
  qsv: boolean;
  vaapi: boolean;
  encoder: string;
}

let cachedGPU: GPUCapabilities | null = null;

async function detectGPU(): Promise<GPUCapabilities> {
  if (cachedGPU) return cachedGPU;

  const result: GPUCapabilities = { nvenc: false, qsv: false, vaapi: false, encoder: 'libx264' };

  try {
    const proc = Bun.spawn(['ffmpeg', '-encoders'], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(proc.stdout).text();

    if (output.includes('h264_nvenc')) {
      result.nvenc = true;
      result.encoder = 'h264_nvenc';
    } else if (output.includes('h264_qsv')) {
      result.qsv = true;
      result.encoder = 'h264_qsv';
    } else if (output.includes('h264_vaapi')) {
      result.vaapi = true;
      result.encoder = 'h264_vaapi';
    }
  } catch {
    // FFmpeg not available
  }

  cachedGPU = result;
  return result;
}

/* ═══════ FFPROBE METADATA ═══════ */

async function getVideoMetadata(filePath: string): Promise<VideoMetadata | null> {
  try {
    const proc = Bun.spawn([
      'ffprobe', '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', filePath,
    ], { stdout: 'pipe', stderr: 'pipe' });

    const output = await new Response(proc.stdout).text();
    const data = JSON.parse(output);
    const video = data.streams?.find((s: any) => s.codec_type === 'video');
    const audio = data.streams?.find((s: any) => s.codec_type === 'audio');

    if (!video) return null;

    return {
      duration: parseFloat(data.format?.duration || '0'),
      width: video.width,
      height: video.height,
      fps: eval(video.r_frame_rate || '0'),
      codec: video.codec_name,
      bitrate: parseInt(data.format?.bit_rate || '0'),
      size: parseInt(data.format?.size || '0'),
      audioCodec: audio?.codec_name,
      audioChannels: audio?.channels,
    };
  } catch {
    return null;
  }
}

/* ═══════ THUMBNAIL EXTRACTION ═══════ */

async function extractThumbnail(
  input: string, output: string, timestamp = '00:00:05', width = 320
): Promise<boolean> {
  try {
    const proc = Bun.spawn([
      'ffmpeg', '-i', input, '-ss', timestamp,
      '-frames:v', '1', '-vf', `scale=${width}:-1`,
      '-q:v', '2', '-y', output,
    ], { stdout: 'pipe', stderr: 'pipe' });

    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/* ═══════ HLS TRANSCODING ═══════ */

async function transcodeToHLS(
  input: string,
  outputDir: string,
  qualities: QualityPreset[],
  segmentDuration: number,
  encoder: string,
  onProgress?: (quality: string, percent: number) => void
): Promise<void> {
  const { mkdir } = await import('fs/promises');

  for (const q of qualities) {
    const qDir = `${outputDir}/${q.name}`;
    await mkdir(qDir, { recursive: true });

    const args = ['-i', input, '-y'];

    // GPU encoder setup
    if (encoder === 'h264_nvenc') {
      args.unshift('-hwaccel', 'cuda');
      args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq');
    } else if (encoder === 'h264_qsv') {
      args.push('-c:v', 'h264_qsv', '-preset', 'medium');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '23');
    }

    args.push(
      '-vf', `scale=${q.width}:${q.height}`,
      '-b:v', q.bitrate,
      '-maxrate', q.maxrate,
      '-bufsize', q.bufsize,
      '-c:a', 'aac', '-b:a', q.audioBitrate,
      '-f', 'hls',
      '-hls_time', String(segmentDuration),
      '-hls_list_size', '0',
      '-hls_segment_filename', `${qDir}/segment_%03d.ts`,
      `${qDir}/playlist.m3u8`
    );

    const proc = Bun.spawn(['ffmpeg', ...args], { stdout: 'pipe', stderr: 'pipe' });

    // Parse progress from stderr
    if (onProgress) {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      let duration = 0;
      let buffer = '';

      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const durMatch = buffer.match(/Duration: (\d+):(\d+):(\d+)/);
          if (durMatch && !duration) {
            duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]);
          }

          const timeMatch = buffer.match(/time=(\d+):(\d+):(\d+)/g);
          if (timeMatch && duration > 0) {
            const last = timeMatch[timeMatch.length - 1];
            const m = last.match(/time=(\d+):(\d+):(\d+)/);
            if (m) {
              const current = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
              onProgress(q.name, Math.round((current / duration) * 100));
            }
          }
        }
      })();
    }

    await proc.exited;
    if (proc.exitCode !== 0) {
      throw new Error(`FFmpeg failed for ${q.name} with exit code ${proc.exitCode}`);
    }
  }

  // Generate master playlist
  let master = '#EXTM3U\n#EXT-X-VERSION:3\n\n';
  for (const q of qualities) {
    const bandwidth = parseInt(q.bitrate) * 1000;
    master += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${q.width}x${q.height}\n`;
    master += `${q.name}/playlist.m3u8\n\n`;
  }
  await Bun.write(`${outputDir}/master.m3u8`, master);
}

/* ═══════ SUBTITLE CONVERTER ═══════ */

function srtToVtt(srt: string): string {
  let vtt = 'WEBVTT\n\n';
  vtt += srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, '$1:$2:$3.$4')
    .replace(/^\d+\n/gm, '');
  return vtt;
}

/* ═══════ TRANSCODE QUEUE ═══════ */

class TranscodeQueue {
  private queue: TranscodeJob[] = [];
  private processing = 0;
  private maxConcurrent: number;
  private segmentDuration: number;

  constructor(maxConcurrent = 2, segmentDuration = 6) {
    this.maxConcurrent = maxConcurrent;
    this.segmentDuration = segmentDuration;
  }

  enqueue(input: string, outputDir: string): string {
    const job: TranscodeJob = {
      id: crypto.randomUUID(),
      input, outputDir,
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    };
    this.queue.push(job);
    this.processNext();
    return job.id;
  }

  getStatus(id: string): TranscodeJob | undefined {
    return this.queue.find(j => j.id === id);
  }

  getAllStatus(): TranscodeJob[] {
    return [...this.queue];
  }

  private async processNext() {
    if (this.processing >= this.maxConcurrent) return;
    const job = this.queue.find(j => j.status === 'queued');
    if (!job) return;

    this.processing++;
    job.status = 'processing';

    try {
      const gpu = await detectGPU();
      await transcodeToHLS(
        job.input, job.outputDir, DEFAULT_LADDER,
        this.segmentDuration, gpu.encoder,
        (quality, percent) => { job.progress = percent; }
      );
      job.status = 'done';
      job.progress = 100;
    } catch (err: any) {
      job.status = 'failed';
      job.error = err.message;
    } finally {
      this.processing--;
      this.processNext();
    }
  }
}

/* ═══════ RANGE REQUEST HANDLER ═══════ */

function serveVideoRange(c: Context, filePath: string, fileSize: number): Response {
  const range = c.req.headers.get('range');
  const mime = filePath.endsWith('.mp4') ? 'video/mp4'
    : filePath.endsWith('.webm') ? 'video/webm'
    : filePath.endsWith('.ts') ? 'video/mp2t'
    : 'application/octet-stream';

  if (!range) {
    return new Response(Bun.file(filePath).stream(), {
      headers: {
        'content-type': mime,
        'content-length': String(fileSize),
        'accept-ranges': 'bytes',
      },
    });
  }

  const [startStr, endStr] = range.replace('bytes=', '').split('-');
  const start = parseInt(startStr, 10);
  const end = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024, fileSize - 1);
  const contentLength = end - start + 1;

  return new Response(Bun.file(filePath).slice(start, end + 1).stream(), {
    status: 206,
    headers: {
      'content-range': `bytes ${start}-${end}/${fileSize}`,
      'accept-ranges': 'bytes',
      'content-length': String(contentLength),
      'content-type': mime,
    },
  });
}

/* ═══════ MIDDLEWARE ═══════ */

/**
 * Video streaming middleware.
 *
 * Routes:
 *   GET /videos/:filename — Stream video with range requests
 *   GET /videos/:filename/meta — Video metadata JSON
 *   GET /videos/:filename/thumb/:n — Thumbnail at n seconds
 *   GET /videos/:filename/hls/master.m3u8 — HLS master playlist
 *   GET /videos/:filename/hls/:quality/playlist.m3u8 — Quality playlist
 *   GET /videos/:filename/hls/:quality/:segment — HLS segment
 *   POST /videos/:filename/transcode — Start HLS transcoding
 *   GET /videos/transcode/:jobId — Transcode job status
 */
export function videoStreamer(options: VideoStreamerOptions): Middleware {
  const prefix = options.prefix || '/videos';
  const transcodeQueue = new TranscodeQueue(
    options.maxConcurrentTranscode || 2,
    options.segmentDuration || 6
  );

  // Init GPU detection
  if (options.autoDetectGPU !== false) {
    detectGPU().then(gpu => {
      console.log(`[Vajra Video] GPU encoder: ${gpu.encoder}${gpu.nvenc ? ' (NVENC)' : gpu.qsv ? ' (QSV)' : ''}`);
    });
  }

  // Ensure directories
  (async () => {
    const { mkdir } = await import('fs/promises');
    await mkdir(options.storage, { recursive: true }).catch(() => {});
    await mkdir(options.cache, { recursive: true }).catch(() => {});
  })();

  return async (c, next) => {
    if (!c.path.startsWith(prefix + '/')) return next();

    const path = c.path.slice(prefix.length + 1);

    // Security: path traversal
    if (path.includes('..') || path.includes('\0')) {
      return c.json({ error: 'Invalid path', code: 'INVALID_PATH' }, 400);
    }

    // Transcode status: GET /videos/transcode/:jobId
    if (path.startsWith('transcode/')) {
      const jobId = path.slice(10);
      const job = transcodeQueue.getStatus(jobId);
      if (!job) return c.json({ error: 'Job not found' }, 404);
      return c.json(job);
    }

    // Parse filename and action
    const parts = path.split('/');
    const filename = parts[0];
    const action = parts[1]; // meta, thumb, hls, transcode

    const filePath = `${options.storage}/${filename}`;
    const file = Bun.file(filePath);

    if (!await file.exists()) {
      return c.json({ error: 'Video not found', code: 'NOT_FOUND' }, 404);
    }

    // GET /videos/:filename — Stream
    if (!action) {
      return serveVideoRange(c, filePath, file.size);
    }

    // GET /videos/:filename/meta
    if (action === 'meta') {
      const meta = await getVideoMetadata(filePath);
      if (!meta) return c.json({ error: 'Failed to read metadata' }, 500);
      return c.json(meta);
    }

    // GET /videos/:filename/thumb/:seconds
    if (action === 'thumb') {
      const seconds = parseInt(parts[2] || '5');
      const thumbPath = `${options.cache}/${filename}_thumb_${seconds}.jpg`;
      const thumbFile = Bun.file(thumbPath);

      if (!await thumbFile.exists()) {
        const timestamp = `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        const ok = await extractThumbnail(filePath, thumbPath, timestamp);
        if (!ok) return c.json({ error: 'Thumbnail extraction failed' }, 500);
      }

      c.setHeader('content-type', 'image/jpeg');
      c.setHeader('cache-control', 'public, max-age=86400');
      return new Response(Bun.file(thumbPath).stream(), { status: 200, headers: c['_headers'] });
    }

    // HLS endpoints
    if (action === 'hls') {
      const hlsDir = `${options.cache}/${filename}_hls`;
      const hlsPath = parts.slice(2).join('/');

      if (!hlsPath || hlsPath === 'master.m3u8') {
        const masterFile = Bun.file(`${hlsDir}/master.m3u8`);
        if (!await masterFile.exists()) {
          return c.json({ error: 'HLS not generated yet. POST to /transcode first.' }, 404);
        }
        c.setHeader('content-type', 'application/vnd.apple.mpegurl');
        return new Response(masterFile.stream(), { status: 200, headers: c['_headers'] });
      }

      // Serve segment or quality playlist
      const segFile = Bun.file(`${hlsDir}/${hlsPath}`);
      if (!await segFile.exists()) {
        return c.json({ error: 'Segment not found' }, 404);
      }

      const contentType = hlsPath.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
      c.setHeader('content-type', contentType);
      return new Response(segFile.stream(), { status: 200, headers: c['_headers'] });
    }

    // POST /videos/:filename/transcode
    if (action === 'transcode' && c.method === 'POST') {
      const hlsDir = `${options.cache}/${filename}_hls`;
      const jobId = transcodeQueue.enqueue(filePath, hlsDir);
      return c.json({ jobId, status: 'queued', statusUrl: `${prefix}/transcode/${jobId}` }, 202);
    }

    return next();
  };
}

export {
  detectGPU,
  getVideoMetadata,
  extractThumbnail,
  transcodeToHLS,
  srtToVtt,
  TranscodeQueue,
  DEFAULT_LADDER,
};

export type { VideoStreamerOptions, VideoMetadata, TranscodeJob, QualityPreset, GPUCapabilities };
