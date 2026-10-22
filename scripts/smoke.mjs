import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, platform, release } from "node:os";
import { execFileSync } from "node:child_process";
import { createCipheriv } from "node:crypto";

const require = createRequire(import.meta.url);
const userData = await mkdtemp(join(tmpdir(), "unimusic-smoke-"));
const env = { ...process.env, UNIMUSIC_TEST_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
let rendererServer;
if (process.argv.includes("--dev")) {
  const { createServer } = await import("vite");
  const { default: config } = await import("../electron.vite.config.ts");
  rendererServer = await createServer({
    ...config.renderer,
    configFile: false,
    server: { host: "127.0.0.1", port: 5175, strictPort: true },
  });
  await rendererServer.listen();
  env.ELECTRON_RENDERER_URL = rendererServer.resolvedUrls.local[0];
}
const packagedExecutable = process.env.UNIMUSIC_EXECUTABLE;
const app = await electron.launch({
  executablePath: packagedExecutable || require("electron"),
  args: packagedExecutable ? [] : [resolve(".")],
  env,
  timeout: 90_000,
});
const errors = [];
const reportDir = resolve("test-results");
let window;
try {
  window = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true));
  assert.equal(await app.evaluate(({ app }) => app.getPath('sessionData')), userData);
  await window.evaluate(() => window.unimusic.preferences({autoCache:false}));
  window.on("pageerror", (error) => errors.push(error.message));
  assert.equal(await app.evaluate(({ nativeTheme })=>nativeTheme.shouldUseDarkColors),true);
  await window.waitForFunction(()=>getComputedStyle(document.documentElement).backgroundColor==='rgba(0, 0, 0, 0)');

  await window.getByRole("region", { name: "Главный экран", exact: true }).waitFor();
  if(platform()==='win32' && Number(release().split('.')[2])>=22621){
    const handle=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
    const nativeResult=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`
      Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class UniMusicDwm { [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size); }';
      $material=0; $result=[UniMusicDwm]::DwmGetWindowAttribute([IntPtr]${handle},38,[ref]$material,4); Write-Output ($result.ToString()+':'+$material.ToString());
    `],{encoding:'utf8',windowsHide:true}).trim();
    assert.equal(nativeResult,'0:2','Windows DWM actually uses the Mica main-window material');
  }

  assert.deepEqual(await window.locator('nav .nav-item').allTextContents(), ['Главная','Моя музыка','Поиск','Плейлисты']);
  assert.equal(await window.getByRole('button', {name:'Главная',exact:true}).getAttribute('aria-current'), 'page');
  await window.waitForFunction(
    () => !document.querySelector(".connect-account").disabled,
  );
  await window.waitForFunction(() => document.querySelector(".visualizer canvas")?.dataset.motion === "running");
  assert.equal(await window.locator('.visualizer').innerText().then(s => s.trim()), 'Моя волна');
  assert.equal(await window.evaluate(() => typeof window.require), "undefined");
  assert.equal(
    await window.evaluate(() => typeof window.unimusic.auth),
    "function",
  );
  await mkdir(reportDir, { recursive: true });
  await window.screenshot({ path: join(reportDir, "welcome.png") });

  // Mock at the HTTP boundary: real IPC, auth state machine, storage, UI and player run unchanged.
  await app.evaluate(({ net, session }) => {
    session
      .fromPartition("unimusic-captcha")
      .protocol.handle("https", (request) => {
        if (request.url.startsWith("https://api.vk.com/captcha.php")) {
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="250" height="80"><rect width="250" height="80" fill="white"/><text x="55" y="55" font-size="40" fill="black">ABCD</text></svg>',
            { headers: { "Content-Type": "image/svg+xml" } },
          );
        }
        if (request.url.startsWith("https://id.vk.com/unimusic-test-captcha")) {
          return new Response(
            '<!doctype html><html lang="ru"><button id="solve">Подтвердить тестовую проверку</button><script>document.getElementById("solve").onclick=()=>window.AndroidBridge.VKCaptchaGetResult(JSON.stringify({token:"fixture-captcha-success"}));</script></html>',
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
          );
        }
        return new Response("Unknown test challenge", { status: 404 });
      });
    let refreshedTrack = false;
    let profileVerified = false;
    net.fetch = async (input, init) => {
      if (/^https:\/\/(unimusic\.test|psv\.vkuseraudio\.net|keys\.vk\.com)\//.test(String(input)))
        return globalThis.__mediaResponse(String(input), init);
      const method = String(input).split("/").at(-1);
      const params = new URLSearchParams(String(init?.body ?? ""));
      const track = (id) => ({
        id,
        owner_id: 123,
        title: id === 1 ? "Тестовый трек" : id === 2 ? "Второй трек" : "Восстановление потока",
        artist: "Тестовый исполнитель",
        duration: id === 2 ? 15 : 60,
        url: id === 2 ? 'https://unimusic.test/hls/index.m3u8' : id === 3 && params.get('v') !== '5.90' ? 'https://unimusic.test/broken.m3u8' : `https://unimusic.test/audio-${id}.wav`,
        album: { title: "Тестовый альбом", thumb: { photo_600: `https://unimusic.test/cover${id === 2 ? '-2' : ''}.svg` } },
      });
      let data;
      if (method === "get_anonym_token")
        data = { token: "anonymous-test-token" };
      else if (method === "auth.validateAccount")
        data =
          params.get("success_token") !== "fixture-captcha-success"
            ? {
                error: {
                  error_code: 14,
                  redirect_uri: "https://id.vk.com/unimusic-test-captcha",
                },
              }
            : {
                response: {
                  sid: "test-sid",
                  flow_name: "auth_without_password",
                  next_step: { verification_method: "codegen" },
                },
              };
      else if (method === "ecosystem.checkOtp")
        data = { response: { sid: "verified-sid", can_skip_password: true } };
      else if (method === "token")
        data = {
          access_token: "vk1.a.smoke-test-credential-not-real",
          user_id: 123,
        };
      else if (method === "users.get") {
        if(params.get('captcha_key')==='ABCD') profileVerified=true;
        data =
          !profileVerified
            ? {
                error: {
                  error_code: 14,
                  captcha_sid: "test-image-sid",
                  captcha_img:
                    "https://api.vk.com/captcha.php?sid=test-image-sid",
                },
              }
            : {
                response: [
                  { id: 123, first_name: "Алексей", last_name: "Тестовый" },
                ],
            };
      }
      else if (method === "audio.getPlaylists")
        data = {
          response: {
            count: 1,
            items: [{ id: 7, owner_id: 123, title: "Мой плейлист", count: 2 }],
          },
        };
      else if (method === "audio.get" || method === "audio.search")
        data = { response: { count: 3, items: [track(1), track(2), track(3)] } };
      else if (method === "audio.getById") {
        const id=Number(params.get('audios')?.split('_')[1])||1;
        globalThis.__resolveCount=(globalThis.__resolveCount||0)+1;
        if(globalThis.__failAll)return new Response(JSON.stringify({error:{error_code:15}}),{headers:{'Content-Type':'application/json'}});
        if(globalThis.__stallTrack===id) await new Promise(resolve=>{globalThis.__releaseStall=resolve;});
        if(params.get('v') !== '5.90') throw new Error('Playback must prefer audio API 5.90');
        data = {
          response: [track(Number(params.get("audios")?.split("_")[1]) || 1)],
        };
        if(data.response[0].id===3&&!refreshedTrack){data.response[0].url='https://unimusic.test/broken.m3u8';refreshedTrack=true;}
      }
      else throw new Error(`Unexpected test request: ${method}`);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  });
  const wav = Buffer.alloc(44 + 22050 * 2 * 60);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24);
  wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 22050 * 60; i++) wav.writeInt16LE(i >= 22050 * 8 && i < 22050 * 12 ? 0 : Math.round(Math.sin(2 * Math.PI * 110 * i / 22050) * 10000), 44 + i * 2);
  // Three independent 5-second AAC segments catch native-HLS selection and truncated duration.
  const aacFrame = Buffer.from([0xff, 0xf1, 0x50, 0x40, 0x01, 0xbf, 0xfc, 0x00, 0xc8, 0x00, 0x80, 0x23, 0x80]);
  const aac = Buffer.concat(Array.from({ length: 215 }, () => aacFrame));
  const segmentDuration = 215 * 1024 / 44100;
  const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.vk.com/test-key.bin",IV=0x00000000000000000000000000000000\n' +
    [0, 1, 2].map(i => `#EXTINF:${segmentDuration},\nsegment-${i}.aac\n`).join('') + '#EXT-X-ENDLIST\n';
  const key = Buffer.from('0123456789abcdef');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  const encryptedAac = Buffer.concat([cipher.update(aac), cipher.final()]);
  await app.evaluate((_electron, { wav, aac, key, manifest }) => {
    globalThis.__mediaStats = { segments: 0, keys: 0, forbidden: 0, ua: true };
    globalThis.__mediaResponse = (url, init) => {
      const headers = new Headers(init?.headers);
      globalThis.__mediaStats.ua &&= headers.get('user-agent')?.startsWith('VKAndroidApp/8.15-') === true;
      const path = new URL(url).pathname;
      if(path.endsWith('.svg')){
        const body='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="'+(path.includes('-2')?'#94613f':'#334658')+'"/><circle cx="370" cy="220" r="160" fill="'+(path.includes('-2')?'#547b63':'#ac7d6e')+'"/><path d="M0 450L210 160L420 600H0Z" fill="#222e46"/><path d="M240 600L500 250L600 400V600Z" fill="#7a7588"/></svg>';
        return new Response(body,{headers:{'Content-Type':'image/svg+xml'}});
      }
      if (globalThis.__failFirst && path === '/audio-1.wav') return new Response(null,{status:403});
      if (path === '/broken.m3u8') { globalThis.__mediaStats.forbidden++; return new Response(null, {status:403}); }
      if (url === 'https://unimusic.test/hls/index.m3u8') return new Response(null, {status:302,headers:{Location:'https://psv.vkuseraudio.net/hls/index.m3u8'}});
      if (path.endsWith('.aac')) globalThis.__mediaStats.segments++;
      if (path.endsWith('.bin')) globalThis.__mediaStats.keys++;
      const contentType = path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : path.endsWith('.aac') ? 'audio/aac' : 'audio/wav';
      const body = path.endsWith('.m3u8') ? manifest : Buffer.from(path.endsWith('.bin') ? key : path.endsWith('.aac') ? aac : wav, 'base64');
      return new Response(body, {status:200, headers:{'Content-Type':contentType,'Content-Length':String(typeof body === 'string' ? Buffer.byteLength(body) : body.length)}});
    };
  }, { wav: wav.toString('base64'), aac: encryptedAac.toString('base64'), key: key.toString('base64'), manifest });
  await window.route('https://unimusic.test/cover*.svg', route => route.fulfill({contentType:'image/svg+xml',headers:{'Access-Control-Allow-Origin':'*'},body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#334658"/><circle cx="370" cy="220" r="160" fill="#ac7d6e"/><path d="M0 450L210 160L420 600H0Z" fill="#222e46"/><path d="M240 600L500 250L600 400V600Z" fill="#7a7588"/></svg>'}));
  await window.evaluate(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__testAudio = this; return play.call(this); };
  });
  await window.getByRole("button", { name: "Выбрать музыку", exact: true }).click();
  await window.getByRole("button", { name: "Войти в аккаунт VK", exact: true }).click();
  await window
    .getByLabel("Телефон или почта", { exact: true })
    .fill("smoke@example.com");
  const webCaptchaPromise = app.waitForEvent("window");
  await window.getByRole("button", { name: "Продолжить", exact: true }).click();
  const webCaptcha = await webCaptchaPromise;
  await webCaptcha.waitForLoadState("domcontentloaded");
  const captchaUserAgent = await webCaptcha.evaluate(() => navigator.userAgent);
  assert.match(captchaUserAgent, /Mozilla\/5\.0.*Chrome\//);
  assert.equal(captchaUserAgent.includes("VKAndroidApp/"), false);
  assert.equal(await webCaptcha.evaluate(() => typeof window.require), "undefined");
  assert.equal(await webCaptcha.evaluate(() => typeof window.unimusic), "undefined");
  await webCaptcha
    .getByRole("button", { name: "Подтвердить тестовую проверку", exact: true })
    .click();
  await window.getByLabel("Код подтверждения", { exact: true }).fill("123456");
  const imageCaptchaPromise = app.waitForEvent("window");
  await window.getByRole("button", { name: "Войти", exact: true }).click();
  const imageCaptcha = await imageCaptchaPromise;
  await imageCaptcha
    .getByLabel("Символы с картинки", { exact: true })
    .fill("ABCD");
  await imageCaptcha.waitForFunction(
    () => document.querySelector("#captcha-image").naturalWidth > 0,
  );
  await imageCaptcha.screenshot({ path: join(reportDir, "captcha.png") });
  await imageCaptcha
    .getByRole("button", { name: "Продолжить вход", exact: true })
    .click();
  await window.getByRole("button", { name: "Моя музыка", exact: true }).click();
  await window.getByRole("button", { name: "VK Музыка", exact: true }).click();
  await window
    .getByRole("button", { name: "Слушать: Тестовый трек", exact: true })
    .waitFor();
  const encrypted = await readFile(join(userData, "session.enc"));
  assert.ok(!encrypted.includes(Buffer.from("vk1.a.smoke-test")));
  assert.equal(
    await window.evaluate(() =>
      Object.keys(localStorage).some((key) =>
        /token|password|session/.test(key),
      ),
    ),
    false,
  );
  await window.getByRole('button', {name:'Слушать всё',exact:true}).click();
  await window
    .getByRole("button", { name: "Пауза", exact: true })
    .waitFor({ timeout: 15_000 });
  await window.waitForFunction(
    () => document.querySelector(".seek-row > span")?.textContent !== "0:00",
  );
  await window.getByRole("button", { name: "Открыть главную", exact: true }).click();
  await window.getByRole("heading", { name: "Тестовый трек", exact: true }).waitFor();
  await window.waitForFunction(() => Number(document.querySelector(".visualizer canvas")?.dataset.energy) > .1);
  await window.waitForFunction(() => document.querySelector(".visualizer canvas")?.dataset.motion === "running");
  await window.waitForFunction(() => getComputedStyle(document.querySelector('.album-backdrop')).opacity === '1');
  assert.equal(await window.locator('.visualizer').innerText().then(s => s.trim()), 'Тестовый трек\n\nТестовый исполнитель\n\nМоя волна');
  assert.equal(await window.locator('.orb-album img').count(), 1);
  assert.equal(await window.locator('.ambient-lights i').count(), 4);
  const initialLight = await window.locator('.ambient-lights i').first().evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  await window.waitForFunction(before => { const r = document.querySelector('.ambient-lights i').getBoundingClientRect(); return Math.hypot(r.x - before.x, r.y - before.y) > 4; }, initialLight, { timeout: 3000 });

  assert.ok(await window.evaluate(() => Number(getComputedStyle(document.querySelector('.ambient-lights')).zIndex) < Number(getComputedStyle(document.querySelector('.listening-scene')).zIndex)));
  assert.ok(await window.evaluate(() => Number(getComputedStyle(document.querySelector('.ambient-lights i'), '::before').opacity) > .1));
  assert.ok(await window.evaluate(() => Number(getComputedStyle(document.querySelector('.visualizer')).getPropertyValue('--bass')) > .1));
  assert.notEqual(await window.locator('.visualizer').evaluate(e=>e.style.getPropertyValue('--cover-accent')), 'rgb(197 180 255)', 'actual cover pixels supply the accent');
  assert.match(await window.locator('.orb-album img').getAttribute('src'), /^unimusic-media:/, 'cover is loaded through the CORS-enabled media source');
  const outerPixels=()=>window.evaluate(()=>{
    const c=document.querySelector('.visualizer canvas'), ctx=c.getContext('2d'), pixels=ctx.getImageData(0,0,c.width,c.height).data;
    let count=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(Math.hypot(x-c.width/2,y-c.height/2)>c.width*.41&&pixels[(y*c.width+x)*4+3]>16)count++;
    return count;
  });
  await window.evaluate(()=>{window.__testAudio.currentTime=8.4;});
  await window.waitForFunction(()=>Number(document.querySelector('.visualizer canvas').dataset.energy)<.015);
  const quietPixels=await outerPixels();
  await window.evaluate(()=>{window.__testAudio.currentTime=2;});
  await window.waitForFunction(()=>Number(document.querySelector('.visualizer canvas').dataset.energy)>.4);
  const loudPixels=await outerPixels();
  assert.ok(loudPixels>quietPixels+40, `Real PCM expands painted particles: quiet=${quietPixels}, loud=${loudPixels}`);
  const volume=window.getByRole('slider',{name:'Громкость',exact:true});
  await volume.focus();await volume.press('Home');
  for(let i=0;i<5;i++)await volume.press('ArrowRight');
  assert.equal(await volume.inputValue(),'0.05');
  await window.waitForFunction(()=>Number(document.querySelector('.visualizer canvas').dataset.energy)>.4);
  await window.getByLabel('Позиция воспроизведения',{exact:true}).hover();
  await window.locator('.seek-tooltip').waitFor();
  await window.mouse.move(0, 0);
  await window.waitForFunction(() => getComputedStyle(document.querySelector('.orb-play svg')).opacity === '0');
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    main.setAlwaysOnTop(true); main.show(); main.moveTop(); main.focus();
  });
  await window.bringToFront();
  for (let attempt = 0; attempt < 8; attempt++) {
    await window.getByRole('button', {name:'Приостановить музыку',exact:true}).hover();
    try { await window.waitForFunction(() => getComputedStyle(document.querySelector('.orb-play svg')).opacity === '1', null, {timeout: 700}); break; }
    catch (error) { if (attempt === 7) throw error; await window.bringToFront(); }
  }
  await window.keyboard.press('Tab');
  await window.getByRole('button', {name:'Приостановить музыку',exact:true}).focus();
  assert.equal(await window.locator('.orb-play').evaluate(b => b.matches(':focus-visible')), true);
  await window.locator('.orb-play').evaluate(b => b.blur());
  await window.mouse.move(0, 0);
  await window.waitForFunction(() => getComputedStyle(document.querySelector('.orb-play svg')).opacity === '0');
  await window.screenshot({ path: join(reportDir, "visualizer.png") });
  await window.getByRole('button', {name:'Приостановить музыку',exact:true}).click();
  await window.waitForFunction(() => getComputedStyle(document.querySelector('.album-backdrop')).opacity === '0');
  assert.equal(await window.locator('.visualizer canvas').getAttribute('data-motion'), 'running');
  await window.screenshot({ path: join(reportDir, 'visualizer-paused.png') });
  await window.getByRole('button', {name:'Воспроизвести музыку',exact:true}).click();
  await window.emulateMedia({ reducedMotion: "reduce" });
  await window.waitForFunction(() => document.querySelector(".visualizer canvas")?.dataset.motion === "still");
  await window.emulateMedia({ reducedMotion: "no-preference" });
  await window.waitForFunction(() => Number(document.querySelector(".visualizer canvas")?.dataset.energy) > .1);
  await window.waitForFunction(() => getComputedStyle(document.querySelector('.album-backdrop')).opacity === '1');
  await window.waitForFunction(() => getComputedStyle(document.querySelector('.album-backdrop img')).opacity === '1');
  await window.getByRole('button',{name:'Настройки',exact:true}).click();
  await window.getByRole('checkbox', { name: 'Фоновые огни', exact: true }).uncheck();
  assert.equal(await window.evaluate(() => localStorage.getItem('unimusic-ambient-lights')), 'false');
  await window.getByRole('button', { name: 'Главная', exact: true }).click();
  assert.equal(await window.locator('.ambient-lights').count(), 0);
  await window.waitForFunction(() => Number(document.querySelector('.visualizer canvas').dataset.energy) > .1);
  await window.getByRole('button', { name: 'Настройки', exact: true }).click();
  assert.equal(await window.getByRole('checkbox', { name: 'Фоновые огни', exact: true }).isChecked(), false);
  await window.getByRole('checkbox', { name: 'Фоновые огни', exact: true }).check();
  assert.equal(await window.evaluate(() => localStorage.getItem('unimusic-ambient-lights')), 'true');
  const lightSettings = window.getByRole('region', { name: 'Фоновые огни', exact: true });
  const orbSettings = window.getByRole('region', { name: 'Orbs', exact: true });
  assert.equal(await window.locator('.titlebar').getByRole('button', { name: 'Настройки', exact: true }).count(), 1);
  assert.equal(await window.locator('.player').getByRole('button', { name: 'Настройки', exact: true }).count(), 0);
  assert.equal(await orbSettings.getByRole('radio').count(), 3);
  await lightSettings.scrollIntoViewIfNeeded();
  await window.waitForFunction(() => Number(document.querySelector('.settings-light-driver')?.dataset.energy) > .1);
  await lightSettings.getByRole('slider', { name: 'Количество', exact: true }).focus();
  await lightSettings.getByRole('slider', { name: 'Количество', exact: true }).press('End');
  await lightSettings.getByRole('slider', { name: 'Интенсивность', exact: true }).focus();
  await lightSettings.getByRole('slider', { name: 'Интенсивность', exact: true }).press('End');
  await lightSettings.getByRole('combobox', { name: 'Цвет огней', exact: true }).selectOption('rgb');
  await window.waitForFunction(() => JSON.parse(localStorage.getItem('unimusic-light-settings')).count === 8);
  assert.equal(await lightSettings.locator('.ambient-lights i').count(), 8);
  await window.getByRole('button', { name: 'Главная', exact: true }).click();
  assert.equal(await window.locator('.ambient-lights i').count(), 8);
  assert.equal(await window.locator('.visualizer').evaluate(node => node.style.getPropertyValue('--light-intensity')), '1.5');
  assert.equal(await window.locator('.visualizer').getAttribute('data-light-colors'), 'rgb');
  await window.waitForFunction(() => document.querySelector('.ambient-lights i').style.getPropertyValue('--light-color').startsWith('hsl('));
  const firstHue = await window.locator('.ambient-lights i').first().evaluate(node => node.style.getPropertyValue('--light-color'));
  await window.waitForFunction(before => document.querySelector('.ambient-lights i').style.getPropertyValue('--light-color') !== before, firstHue);

  await window.getByRole('button', { name: 'Настройки', exact: true }).click();
  await lightSettings.getByRole('button', { name: 'По умолчанию', exact: true }).click();
  await window.waitForFunction(() => JSON.stringify(JSON.parse(localStorage.getItem('unimusic-light-settings'))) === JSON.stringify({ count: 4, intensity: 1, speed: 1, size: 1, sensitivity: 1, colorMode: 'accent' }));
  await window.getByRole('button', { name: 'Главная', exact: true }).click();
  assert.equal(await window.locator('.visualizer').getAttribute('data-light-colors'), 'accent');
  await window.waitForFunction(() => document.querySelector('.ambient-lights i').style.getPropertyValue('--light-color') === '');
  await window.getByRole('button', { name: 'Настройки', exact: true }).click();
  await orbSettings.getByRole('checkbox', { name: 'Показывать Orbs', exact: true }).uncheck();
  await window.getByRole('button', { name: 'Главная', exact: true }).click();
  await window.waitForFunction(() => {
    const c = document.querySelector('.visualizer.orbs-disabled canvas');
    return c && !c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v,i) => i % 4 === 3 && v > 0);
  });
  const disabledOrbLight = await window.locator('.ambient-lights i').first().evaluate(node => node.style.transform);
  await window.waitForFunction(before => document.querySelector('.ambient-lights i').style.transform !== before, disabledOrbLight);
  await window.getByRole('button', { name: 'Настройки', exact: true }).click();
  assert.equal(await orbSettings.getByRole('combobox', { name: 'Расположение', exact: true }).isDisabled(), true);
  await orbSettings.getByRole('button', { name: 'По умолчанию', exact: true }).click();
  await orbSettings.getByRole('combobox', { name: 'Расположение', exact: true }).selectOption('background');
  await window.getByRole('button', { name: 'Главная', exact: true }).click();
  assert.equal(await window.locator('.background-orbs canvas').count(), 1);
  assert.equal(await window.locator('.orb-disc canvas').count(), 0);
  assert.equal(await window.locator('.visualizer canvas').count(), 1);
  await window.waitForFunction(() => Number(document.querySelector('.background-orbs canvas').dataset.energy) > .1);
  await window.getByRole('button', { name: 'Настройки', exact: true }).click();
  await orbSettings.getByRole('slider', { name: 'Чувствительность к звуку', exact: true }).focus();
  await orbSettings.getByRole('slider', { name: 'Чувствительность к звуку', exact: true }).press('Home');
  await window.waitForFunction(() => JSON.parse(localStorage.getItem('unimusic-orb-settings')).sensitivity === 0);
  await orbSettings.getByRole('button', { name: 'По умолчанию', exact: true }).click();
  await window.waitForFunction(() => JSON.stringify(JSON.parse(localStorage.getItem('unimusic-orb-settings'))) === JSON.stringify({ enabled: true, placement: 'circle', sensitivity: 1, speed: 1, opacity: 1 }));
  for(const [name,mode] of [['Волна','wave'],['Сплетение','braid'],['Орбиты','orbits']]){
    await window.getByRole('radio',{name:new RegExp(name)}).check();
    await window.waitForFunction(mode=>document.querySelector('.mode-option.selected canvas')?.dataset.mode===mode,mode);
  }
  await window.getByRole('radio',{name:/Сплетение/}).check();
  assert.equal(await window.evaluate(()=>localStorage.getItem('unimusic-orb-mode')), 'braid');
  await window.locator('.mode-option').evaluateAll(nodes=>Promise.all(nodes.flatMap(node=>node.getAnimations().map(animation=>animation.finished.catch(()=>{})))));
  await window.screenshot({path:join(reportDir,'settings.png')});
  await window.emulateMedia({reducedMotion:'reduce'});
  await window.getByRole('checkbox',{name:'Учитывать настройки анимации Windows'}).uncheck();
  await window.locator('.mode-option.selected canvas').scrollIntoViewIfNeeded();
  await window.waitForFunction(()=>document.querySelector('.mode-option.selected canvas')?.dataset.motion==='running');
  await window.getByRole('checkbox',{name:'Учитывать настройки анимации Windows'}).check();
  await window.locator('.mode-option.selected canvas').scrollIntoViewIfNeeded();
  await window.waitForFunction(()=>document.querySelector('.mode-option.selected canvas')?.dataset.motion==='still');
  await window.emulateMedia({reducedMotion:'no-preference'});
  await window.getByRole('button',{name:'Главная',exact:true}).click();
  await window.waitForFunction(()=>document.querySelector('.visualizer canvas')?.dataset.mode==='braid');
  await window.waitForFunction(()=>document.querySelector('.orb-album img')?.naturalWidth>0&&getComputedStyle(document.querySelector('.orb-album')).opacity==='1');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 680));
  assert.ok(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await window.locator('.sidebar').count(), 0, 'full-width layout has no sidebar');
  assert.ok(await window.getByRole('button',{name:'Настройки',exact:true}).isVisible());
  assert.ok(await window.getByRole('button',{name:'Плейлисты',exact:true}).isVisible());
  await window.mouse.move(0, 0);
  await window.waitForFunction(() => getComputedStyle(document.querySelector('.orb-play svg')).opacity === '0');
  await window.screenshot({ path: join(reportDir, "visualizer-compact.png") });
  await window.getByRole('button',{name:'Настройки',exact:true}).click();
  assert.equal(await window.locator('.mode-gallery canvas').count(),3);
  assert.ok(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await window.screenshot({path:join(reportDir,'settings-compact.png')});
  await window.getByRole('button',{name:'Главная',exact:true}).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
  await window.evaluate(()=>{window.__orbCanvas=document.querySelector('.visualizer canvas');window.__previousPalette=document.querySelector('.visualizer').style.getPropertyValue('--cover-accent');});
  await window
    .getByRole("button", { name: "Следующий трек", exact: true })
    .click();
  await window.waitForFunction(
    () =>
      document.querySelector(".now-playing strong")?.textContent ===
      "Второй трек",
  );
  await window.waitForFunction(()=>document.querySelectorAll('.orb-album img').length===2);
  assert.equal(await window.evaluate(()=>window.__orbCanvas===document.querySelector('.visualizer canvas')),true,'canvas survives the track crossfade');
  await window.waitForFunction(()=>document.querySelectorAll('.orb-album img').length===1&&document.querySelector('.visualizer').style.getPropertyValue('--cover-accent')!==window.__previousPalette);
  await window.getByRole("button", { name: "Пауза", exact: true }).waitFor({ timeout: 15000 });
  await window.waitForFunction(() => window.__testAudio?.duration > 14);
  await window.waitForFunction(() => window.__testAudio.buffered.length && window.__testAudio.buffered.end(0) > 11);
  const mediaStats = await app.evaluate(() => globalThis.__mediaStats);
  assert.ok(mediaStats.segments >= 2, 'HLS loads consecutive encrypted AAC segments');
  assert.ok(mediaStats.keys >= 1, 'HLS key on a different VK origin is proxied');
  assert.equal(mediaStats.ua, true, 'Android UA reaches playlists, redirects, keys and fragments');
  assert.match(await window.evaluate(() => window.__testAudio.src), /^blob:/, 'HLS.js takes precedence over partial native HLS support');
  await window.evaluate(() => { window.__testAudio.currentTime = 11; });
  await window.waitForFunction(() => window.__testAudio.currentTime > 11.1 && !window.__testAudio.paused);
  await window.getByRole("button", { name: "Пауза", exact: true }).click();
  await window.getByRole("button", { name: "Моя музыка", exact: true }).click();
  await window
    .getByRole("button", { name: "Показать очередь", exact: true })
    .click();
  assert.equal(await window.locator(".queue-track").count(), 3);
  await window.locator('.queue-panel').evaluate(n=>Promise.all(n.getAnimations().map(a=>a.finished.catch(()=>{}))));
  await window.screenshot({ path: join(reportDir, 'queue.png') });
  await window
    .getByRole("button", { name: "Закрыть очередь", exact: true })
    .click();
  await window.screenshot({ path: join(reportDir, "library.png") });
  await window.getByRole('button', {name:'Слушать: Восстановление потока',exact:true}).click();
  await window.getByRole('button', {name:'Пауза',exact:true}).waitFor({timeout:15000});
  await window.waitForFunction(() => window.__testAudio.currentTime > .1 && window.__testAudio.src.startsWith('unimusic-media:'));
  assert.equal(await window.getByRole('alert').count(), 0, 'Failed HLS falls back to legacy media');
  await window.getByRole("button", { name: "Плейлисты", exact: true }).click();
  await window.locator('.playlist-card').filter({hasText:'Мой плейлист'}).waitFor();
  await window.locator('.playlist-grid').evaluate(n=>Promise.all(n.getAnimations().map(a=>a.finished.catch(()=>{}))));
  await window.screenshot({ path: join(reportDir, 'playlists.png') });
  await window
    .locator(".playlist-card").filter({hasText:"Мой плейлист"})
    .click();
  await window
    .getByRole("button", { name: "Все плейлисты", exact: true })
    .waitFor();
  await window.keyboard.press('Control+k');
  assert.equal(await window.getByLabel('Поиск по VK Music',{exact:true}).evaluate(e=>e===document.activeElement), true);
  await window.getByLabel("Поиск по VK Music", { exact: true }).fill("Тест");
  await window.getByLabel("Поиск по VK Music", { exact: true }).press("Enter");
  await window
    .getByText("Результаты по запросу «Тест»", { exact: true })
    .waitFor();
  await window.getByRole('button', {name:'Слушать: Тестовый трек',exact:true}).waitFor();
  await window.screenshot({ path: join(reportDir, 'search.png') });
  // New music actions remain on fixture HTTP and isolated native-dialog paths.
  await app.evaluate(({ net, dialog }, folder) => {
    const original = net.fetch;
    globalThis.__mutations = [];
    net.fetch = async (input, init) => {
      const method = String(input).split('/').at(-1);
      const params = new URLSearchParams(String(init?.body ?? ''));
      let response;
      if (method === 'audio.getLyrics') {
        if (!/^123_[123]$/.test(params.get('audio_id'))) throw new Error('Wrong lyrics parameter');
        response = { lyrics: { text: ['Test line one', 'Test line two'] } };
      } else if (['audio.add','audio.createPlaylist','audio.editPlaylist','audio.deletePlaylist','audio.addToPlaylist','audio.removeFromPlaylist','audio.edit','audio.delete','audio.restore','audio.reorder'].includes(method)) {
        globalThis.__mutations.push(method);
        response = method === 'audio.createPlaylist' ? { id: 44, owner_id: 123, title: params.get('title'), count: 0 } : method === 'audio.add' ? Number(params.get('audio_id')) : 1;
      } else if (method === 'audio.searchArtists') response = { count: 1, items: [{ id: 'artist-test', name: 'Тестовый артист' }] };
      else if (method === 'catalog.getAudio') response = { catalog: { sections: [{ id: 'test-section', title: 'Подборки' }] } };
      else return original(input, init);
      return new Response(JSON.stringify({ response }), { headers: { 'Content-Type': 'application/json' } });
    };
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.properties.includes('openDirectory') ? folder : `${folder}/import.wav`] });
  }, userData);
  await writeFile(join(userData, 'import.wav'), wav);
  await window.getByRole('button', {name:'Плейлисты',exact:true}).click();
  await window.getByRole('button', {name:'Создать плейлист',exact:true}).click();
  await window.getByLabel('Название',{exact:true}).fill('Созданный плейлист');
  await window.getByRole('button',{name:'Сохранить',exact:true}).click();
  await window.getByRole('dialog').waitFor({state:'hidden'});
  assert.ok(await app.evaluate(()=>globalThis.__mutations.includes('audio.createPlaylist')));
  await window.getByRole('button', {name:'Моя музыка',exact:true}).click();
  const playingTitle = await window.locator('.now-playing strong').textContent();
  await window.getByRole('button',{name:'Убрать лайк с текущей песни',exact:true}).click();
  await window.getByRole('button',{name:`Мне нравится: ${playingTitle}`,exact:true}).waitFor();
  await window.getByRole('button',{name:`Мне нравится: ${playingTitle}`,exact:true}).click();
  await window.getByRole('button',{name:'Убрать лайк с текущей песни',exact:true}).waitFor();
  await window.screenshot({path:join(reportDir,'track-actions.png')});
  await window.getByRole('button', {name:'Текст песни',exact:true}).click();
  await window.getByText('Test line one\nTest line two',{exact:true}).waitFor();
  assert.equal(await window.getByRole('dialog').count(), 0);
  await window.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector('.listening-scene')).transform).m41 < -150);
  await window.screenshot({path:join(reportDir,'lyrics-home.png')});
  await window.getByRole('button',{name:'Закрыть текст песни',exact:true}).click();
  await window.waitForFunction(() => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.listening-scene')).transform).m41) < 1);
  await window.getByRole('button', {name:'Моя музыка',exact:true}).click();
  await window.getByRole('button', {name:'Действия: Тестовый трек',exact:true}).click();
  assert.ok(await window.locator('.menu-actions > button').count() <= 6);
  await window.getByRole('button',{name:'Поделиться',exact:true}).click();
  await window.getByRole('button',{name:'QR-код ссылки',exact:true}).click();
  await window.locator('.track-qr').waitFor();
  await window.getByRole('button',{name:'Закрыть диалог',exact:true}).click();
  await window.getByRole('button',{name:'Действия: Восстановление потока',exact:true}).click();
  await window.getByRole('button',{name:'Слушать следующим',exact:true}).click();
  await window.getByRole('button',{name:'Показать очередь',exact:true}).click();
  await window.getByRole('button',{name:'Выше: Второй трек',exact:true}).click();
  assert.equal(await window.locator('.queue-track strong').first().textContent(),'Второй трек');
  await window.getByRole('button',{name:'Закрыть очередь',exact:true}).click();
  const features = await window.evaluate(async () => {
    const api = window.unimusic;
    const list = await api.browse({ kind: 'library' });
    if (!list.ok) throw new Error(list.error);
    const lyrics = await api.lyrics(list.data.tracks[0]);
    const artists = await api.browse({kind:'search',query:'test',filters:{type:'artists'}});
    const catalog = await api.browse({kind:'catalog'});
    await api.offline({type:'directory'});
    const imported = await api.offline({type:'import'});
    const download = await api.offline({type:'download',tracks:list.data.tracks.slice(0,2)});
    return {lyrics:lyrics.ok,artists:artists.ok&&artists.data.artists.length,catalog:catalog.ok&&catalog.data.sections.length, imported: imported.ok, download:download.ok};
  });
  assert.deepEqual(features,{lyrics:true,artists:1,catalog:1,imported:true,download:true});
  await poll(()=>window.evaluate(async()=>{
    const r=await window.unimusic.offline({type:'list'});
    if(!r.ok)throw new Error(r.error);
    const error=r.data.entries.find(e=>e.state==='error');
    if(error)throw new Error(error.error);
    return r.data.entries.filter(e=>e.state==='complete').length===3;
  }));
  const localResult=await window.evaluate(async()=>{
    const r=await window.unimusic.offline({type:'list'});if(!r.ok)throw new Error(r.error);
    const downloaded=r.data.entries.find(e=>e.track.id===2&&e.track.ownerId===123);
    const source=await window.unimusic.resolveTrack(downloaded.track);
    const info=await window.unimusic.trackInfo(downloaded.track);
    return {local:source.ok&&source.data.url.startsWith('unimusic-media://file/'),size:info.ok&&info.data.size>1000, ...(!source.ok?{sourceError:source.error}:{}), ...(!info.ok?{infoError:info.error}:{})};
  });
  assert.deepEqual(localResult,{local:true,size:true});
  await window.getByRole('button',{name:'На устройстве',exact:true}).click();
  await window.getByRole('button',{name:'Добавить файлы',exact:true}).waitFor();
  await window.screenshot({path:join(reportDir,'offline.png')});
  await window.evaluate(async()=>{await window.unimusic.preferences({preferDownloads:false});await window.unimusic.offline({type:'clear'});});
  await window.getByRole('button',{name:'Настройки',exact:true}).click();
  await window.getByRole('checkbox',{name:'Продолжать музыку в трее при закрытии окна',exact:true}).click();
  await window.waitForFunction(()=>[...document.querySelectorAll('label')].find(e=>e.textContent.includes('Продолжать музыку в трее'))?.querySelector('input')?.checked);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  await window.getByRole('checkbox',{name:'Продолжать музыку в трее при закрытии окна',exact:true}).click();
  await window.waitForFunction(()=>![...document.querySelectorAll('label')].find(e=>e.textContent.includes('Продолжать музыку в трее'))?.querySelector('input')?.checked);
  await window.screenshot({path:join(reportDir,'advanced-settings.png')});
  // Fault injection uses the real player: native failures, re-prepare position and queue exhaustion.
  await window.getByRole('button',{name:'Моя музыка',exact:true}).click();
  await app.evaluate(()=>{globalThis.__failFirst=true;globalThis.__resolveCount=0;});
  await window.getByRole('button',{name:'Слушать всё',exact:true}).click();
  await window.waitForFunction(()=>document.querySelector('.now-playing strong')?.textContent==='Второй трек');
  await window.getByRole('button',{name:'Пауза',exact:true}).waitFor();
  assert.ok(await app.evaluate(()=>globalThis.__resolveCount)>=2,'failed native track is retried and skipped');
  assert.equal(await window.getByRole('alert').count(),0);
  await app.evaluate(()=>{globalThis.__failFirst=false;});
  await window.getByRole('button',{name:'Слушать всё',exact:true}).click();
  await window.waitForFunction(()=>window.__testAudio.currentTime>.1&&document.querySelector('.now-playing strong')?.textContent==='Тестовый трек');
  await window.evaluate(()=>{
    const a=window.__testAudio;a.currentTime=25;
    Object.defineProperty(a,'error',{value:{code:2},configurable:true});a.dispatchEvent(new Event('error'));delete a.error;
  });
  await window.waitForFunction(()=>window.__testAudio.currentTime>25&&!window.__testAudio.paused);
  assert.equal(await window.locator('.now-playing strong').textContent(),'Тестовый трек','network recovery resumes the same track at its previous position');
  await window.clock.install();
  await app.evaluate(()=>{globalThis.__stallTrack=1;globalThis.__releaseStall=null;});
  await window.getByRole('button',{name:'Слушать всё',exact:true}).click();
  await app.evaluate(()=>new Promise((resolve,reject)=>{
    const poll=setInterval(()=>{if(globalThis.__releaseStall){clearInterval(poll);resolve();}},10);
    setTimeout(()=>{clearInterval(poll);reject(new Error('No stalled request'));},2000);
  }));
  await window.clock.fastForward(21_000);
  await window.waitForFunction(()=>document.querySelector('.now-playing strong')?.textContent==='Второй трек');
  await app.evaluate(()=>{globalThis.__stallTrack=0;globalThis.__releaseStall?.();});
  await window.getByRole('button',{name:'Пауза',exact:true}).waitFor();
  assert.equal(await window.locator('.now-playing strong').textContent(),'Второй трек','late response cannot replace the next track');
  await app.evaluate(()=>{globalThis.__stallTrack=3;globalThis.__releaseStall=null;});
  await window.getByRole('button',{name:'Слушать: Восстановление потока',exact:true}).click();
  await app.evaluate(()=>new Promise((resolve,reject)=>{
    const poll=setInterval(()=>{if(globalThis.__releaseStall){clearInterval(poll);resolve();}},10);
    setTimeout(()=>{clearInterval(poll);reject(new Error('No stalled last track'));},2000);
  }));
  await window.getByRole('button',{name:'Повтор выключен',exact:true}).click();
  await window.clock.fastForward(21_000);
  await window.waitForFunction(()=>document.querySelector('.now-playing strong')?.textContent==='Тестовый трек');
  await app.evaluate(()=>{globalThis.__stallTrack=0;globalThis.__releaseStall?.();});
  await window.getByRole('button',{name:'Пауза',exact:true}).waitFor();
  assert.equal(await window.locator('.now-playing strong').textContent(),'Тестовый трек','repeat enabled during loading is respected by automatic advancement');
  await window.evaluate(()=>window.__testAudio.dispatchEvent(new Event('stalled')));
  await window.waitForFunction(()=>!document.querySelector('.play-button').disabled);
  await app.evaluate(()=>{globalThis.__failAll=true;globalThis.__resolveCount=0;});
  await window.getByRole('button',{name:'Слушать всё',exact:true}).click();
  await window.getByRole('alert').filter({hasText:'Следующих доступных треков нет'}).waitFor();
  assert.equal(await app.evaluate(()=>globalThis.__resolveCount),3,'each failed recording is visited once even in repeat-all');
  await window.clock.fastForward(60_000);
  assert.equal(await app.evaluate(()=>globalThis.__resolveCount),3,'an exhausted queue does not keep retrying');
  await app.evaluate(()=>{globalThis.__failAll=false;});
  await window.reload();
  await window.getByRole('button',{name:'Выйти из VK',exact:true}).waitFor();
  await window.waitForFunction(()=>document.querySelector('.visualizer canvas')?.dataset.mode==='braid');
  await window.getByRole('button',{name:'Настройки',exact:true}).click();
  assert.equal(await window.getByRole('radio',{name:/Сплетение/}).isChecked(),true,'Orbs mode survives a renderer restart');
  await window
    .getByRole("button", { name: "Выйти из VK", exact: true })
    .click();
  await window.getByRole("button", { name: /Войти в аккаунт/ }).waitFor();
  await assert.rejects(readFile(join(userData, "session.enc")), {
    code: "ENOENT",
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: auth/captchas, encrypted session, native media proxy, redirected encrypted HLS/AAC and cross-origin keys, seeking, HLS failure fallback, native Mica, full-width navigation, real FFT glow, Orbs modes, crossfade, reduced motion, compact layout, queue/search, recovery position, failed-track skip, 20-second loading watchdog, bounded queue exhaustion and logout.",
  );
} catch (error) {
  if(window){
    console.error('UI state:', await window.evaluate(()=>{const b=document.querySelector('.orb-play'),v=document.querySelector('.visualizer');return {hidden:document.hidden,playing:!!document.querySelector('.visualizer.is-playing'),energy:document.querySelector('.music-orb')?.dataset.energy,bass:v?getComputedStyle(v).getPropertyValue('--bass'):null,hover:b?.matches(':hover'),disabled:b?.disabled,opacity:b?getComputedStyle(b.querySelector('svg')).opacity:null};}).catch(()=>null));
    await window.screenshot({path:join(reportDir,'failure.png')}).catch(()=>{});
  }
  throw error;
} finally {
  await app.close();
  await rendererServer?.close();
  // The generated directory is the only recursive cleanup target.
  assert.ok(userData.startsWith(join(tmpdir(), "unimusic-smoke-")));
  await rm(userData, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 300,
  });
}

async function poll(action) {
 const deadline=Date.now()+60000;
 while(Date.now()<deadline){if(await action())return;await new Promise(r=>setTimeout(r,150));}
 throw new Error("Asynchronous feature check timed out");
}
