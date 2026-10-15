// 后台网页上传：浏览器内压缩视频（WebCodecs，经 mediabunny）+ 通过 GitHub API 一次提交到仓库
// 只在管理员上传时按需加载，投票者页面不会用到
import { Input, Output, Conversion, CanvasSink, ALL_FORMATS, BlobSource, BufferTarget, Mp4OutputFormat } from './vendor/mediabunny.min.mjs';

export const supported = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

const REASON = {
  undecodable_source_codec: '这台电脑的浏览器解不开该视频的编码（常见于 HEVC/H.265），请换一台较新的电脑或用 Chrome/Edge 最新版',
  no_encodable_target_codec: '浏览器不支持编码 H.264，请换用最新版 Chrome 或 Edge',
  unknown_source_codec: '无法识别的视频编码',
};

// 压缩：长边不超过 1280、30 帧、H.264 约 0.65 Mbps；音频能直接复制就复制（手机视频一般是 AAC），否则转 AAC
// 已符合要求的视频（≤720p、H.264、AAC/无声、≤30 帧、总码率≤1.2 Mbps、mp4/mov）只重新封装，不动画面，几秒完成
export async function compress(file, onProgress) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('文件里没有视频画面');
  const at = await input.getPrimaryAudioTrack();
  const landscape = vt.displayWidth >= vt.displayHeight;
  const long = Math.max(vt.displayWidth, vt.displayHeight);
  const fps = (await vt.computePacketStats(120).catch(() => null))?.averagePacketRate || 30;
  const dur = await input.computeDuration().catch(() => 0);
  const kbps = dur ? file.size * 8 / dur / 1000 : Infinity;
  const skip = /\.(mp4|m4v|mov)$/i.test(file.name) && vt.codec === 'avc' && long <= 1280 && fps <= 31
    && (!at || at.codec === 'aac') && kbps <= 1200;
  const size = long > 1280 ? (landscape ? { width: 1280 } : { height: 1280 }) : {};
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  // 浏览器多用显卡编码器，同码率下效率不如 x264，故码率给低一些，体积与脚本版相当
  const conv = await Conversion.init({
    input, output, tracks: 'primary', showWarnings: false,
    video: skip ? {} : { ...size, ...(fps > 31 ? { frameRate: 30 } : {}), codec: 'avc', bitrate: 650_000, forceTranscode: true },
    audio: skip ? {} : { codec: 'aac' },
  });
  const lostVideo = conv.discardedTracks.find(d => d.track.isVideoTrack());
  if (!conv.isValid || lostVideo) throw new Error(REASON[lostVideo && lostVideo.reason] || '浏览器无法处理这个视频');
  const lostAudio = conv.discardedTracks.some(d => d.track.isAudioTrack());
  conv.onProgress = p => onProgress && onProgress(p);
  await conv.execute();
  return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), noAudio: lostAudio, skipped: skip };
}

// 封面：取第 1 秒（短视频取中间）一帧，长边 640 的 JPEG
// 用解码器直接取帧（不依赖 <video> 播放器，后者在页面外常常不解码、截到黑屏或卡住）
export async function poster(blob) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const vt = await input.getPrimaryVideoTrack();
  const dur = await vt.computeDuration();
  const k = Math.min(1, 640 / Math.max(vt.displayWidth, vt.displayHeight));
  const sink = new CanvasSink(vt, { width: Math.round(vt.displayWidth * k), height: Math.round(vt.displayHeight * k), fit: 'contain' });
  const frame = await sink.getCanvas(Math.min(1, dur / 2));
  if (!frame) return null;
  const c = frame.canvas;
  return c.convertToBlob ? c.convertToBlob({ type: 'image/jpeg', quality: 0.8 }) : new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.8));
}

const toBase64 = blob => new Promise((ok, bad) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1]);
  r.onerror = () => bad(new Error('读取文件失败'));
  r.readAsDataURL(blob);
});

// GitHub 单个请求超过约 60 秒会被拒（并误报 Bad credentials），所以慢网络下要换成可读的提示
const SLOW_MSG = '上传太慢被 GitHub 中断：这台电脑的网络到 GitHub 速度不够，请先在后台点「上传测速」，或换个网络/用原电脑的脚本上传';
const ghClient = cfg => async (path, opts = {}) => {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${cfg.repo}${path}`, {
      ...opts,
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch (e) { throw new Error('连不上 GitHub，请检查网络'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(res.status === 401 && Date.now() - t0 > 40000 ? SLOW_MSG : `GitHub：${data.message || res.status}`);
    e.status = res.status; throw e;
  }
  return data;
};

// 上传测速：传一个随机内容的 blob（不提交、不影响网站），按实际传输字节算速度
export async function speedTest(cfg, mb = 1) {
  const bytes = crypto.getRandomValues(new Uint8Array(65536));
  const parts = Array.from({ length: mb * 16 }, () => bytes.map(b => b ^ (Math.random() * 256)));
  const body = JSON.stringify({ content: await toBase64(new Blob(parts)), encoding: 'base64' });
  const t0 = performance.now();
  await ghClient(cfg)('/git/blobs', { method: 'POST', body });
  const secs = (performance.now() - t0) / 1000;
  return { secs, kbps: body.length / 1024 / secs };
}

// 把多个文件作为一次提交推到仓库（只触发一次 Pages 构建）。并发冲突时重试
export async function commitFiles(cfg, files, message, onStep) {
  const gh = ghClient(cfg);
  const blobs = [];
  for (const [i, f] of files.entries()) {
    onStep && onStep(`上传文件 ${i + 1}/${files.length}`);
    const { sha } = await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: await toBase64(f.blob), encoding: 'base64' }) });
    blobs.push({ path: f.path, mode: '100644', type: 'blob', sha });
  }
  for (let attempt = 0; ; attempt++) {
    onStep && onStep('提交到仓库');
    const ref = await gh(`/git/ref/heads/${cfg.branch}`);
    const head = await gh(`/git/commits/${ref.object.sha}`);
    const tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: blobs }) });
    const commit = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }) });
    try {
      await gh(`/git/refs/heads/${cfg.branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
      return commit.sha;
    } catch (e) {
      if (e.status === 422 && attempt < 3) continue; // 别人刚好也提交了，基于最新版本重来
      throw e;
    }
  }
}
