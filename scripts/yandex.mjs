// Uses isolated storage and fixture HTTP.
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'unimusic-yandex-'));
const env = { ...process.env, UNIMUSIC_TEST_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.UNIMUSIC_EXECUTABLE;
const app = await electron.launch({ executablePath: executable || require('electron'), args: executable ? [] : [resolve('.')], env });
try {
  const page = await app.firstWindow(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => window.unimusic.preferences({ autoCache: false }));
  const wav = Buffer.alloc(44 + 22050 * 2 * 30);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 22050 * 30; i++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 110 * i / 22050) * 10000), 44 + i * 2);
  await app.evaluate(({ net, BrowserWindow, shell }, bytes) => {
    BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true);
    globalThis.__yandexLiked = true; globalThis.__yandexDisliked = false; globalThis.__yandexPreview = false;
    shell.openExternal = async url => { globalThis.__yandexOpened = url; };
    const song = { id: 17, title: 'Яндекс тест', artists: [{ id: 4, name: 'Исполнитель Яндекса' }], albums: [{ id: 7, title: 'Альбом Яндекса' }], durationMs: 30000 };
    const playlist = { kind: 8, owner: { uid: 42 }, title: 'Плейлист Яндекса', trackCount: 1 };
    net.fetch = async (input, init) => {
      const url = new URL(String(input)); const path = url.pathname; const params = new URLSearchParams(String(init?.body ?? ''));
      const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      if (url.hostname === 'oauth.yandex.ru') {
        if (path === '/device/code') return json({ device_code: 'private-fixture-code', user_code: 'ABCD', verification_url: 'https://ya.ru/device', expires_in: 600, interval: 5 });
        return json({ access_token: 'fixture-yandex-token-not-real' });
      }
      if (url.hostname === 'storage.yandex.net') {
        if (new Headers(init?.headers).has('Authorization')) throw new Error('Credential sent to CDN');
        if (path === '/lyrics') return new Response('Текст Яндекса для проверки');
        if (path === '/info') return new Response('<download-info><host>storage.yandex.net</host><path>/song.mp3</path><ts>68beac3a</ts><s>salt</s></download-info>');
        return new Response(Buffer.from(bytes), { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(bytes.length) } });
      }
      if (url.hostname !== 'api.music.yandex.net') throw new Error('Unexpected service request');
      if (path === '/account/status') return json({ result: { account: { uid: 42, displayName: 'Тест Яндекс' }, plus: { hasPlus: true } } });
      if (path === '/users/42/likes/tracks') return json({ result: { library: { tracks: globalThis.__yandexLiked ? [{ id: 17 }] : [] } } });
      if (path === '/users/42/dislikes/tracks') return json({ result: { library: { tracks: globalThis.__yandexDisliked ? [{ id: 17 }] : [] } } });
      if (path.includes('/dislikes/tracks/')) { globalThis.__yandexDisliked = path.endsWith('add-multiple'); if (globalThis.__yandexDisliked) globalThis.__yandexLiked = false; return json({ result: { revision: 3 } }); }
      if (path.includes('/likes/tracks/')) { globalThis.__yandexLiked = path.endsWith('add-multiple'); if (globalThis.__yandexLiked) globalThis.__yandexDisliked = false; return json({ result: { revision: 2 } }); }
      if (path === '/tracks') return json({ result: params.get('track-ids').split(',').map(id => ({ ...song, id: Number(id), title: Number(id) === 18 ? 'Вторая песня волны' : song.title })) });
      if (path === '/tracks/17/lyrics') return json({ result: { downloadUrl: 'https://storage.yandex.net/lyrics' } });
      if (path.endsWith('/feedback')) return json({ result: 'ok' });
      if (path === '/rotor/station/user:onyourwave/tracks') return json({ result: { batchId: 'fixture-batch', sequence: [{ track: song }, { track: { ...song, id: 18, title: 'Вторая песня волны' } }] } });
      if (/^\/tracks\/(17|18)\/download-info$/.test(path)) return json({ result: [{ codec: 'mp3', preview: globalThis.__yandexPreview, bitrateInKbps: 320, downloadInfoUrl: 'https://storage.yandex.net/info' }] });
      if (path === '/users/42/playlists/list') return json({ result: [playlist] });
      if (path === '/users/42/playlists/8') return json({ result: { ...playlist, tracks: [{ id: 17 }] } });
      if (path === '/search') return json({ result: { tracks: { total: 1, results: [song] } } });
      if (path === '/artists/4/tracks') return json({ result: { tracks: [song], pager: { total: 1 } } });
      if (path === '/artists/4/direct-albums') return json({ result: { albums: [{ id: 7, title: 'Альбом Яндекса', trackCount: 1 }], pager: { total: 1 } } });
      if (path === '/albums/7/with-tracks') return json({ result: { volumes: [[song]] } });
      throw new Error(`Unexpected fixture path ${path}`);
    };
  }, [...wav]);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('navigation', { name: 'Разделы настроек', exact: true }).getByRole('button', { name: 'Яндекс Музыка', exact: true }).click();
  await page.getByRole('button', { name: 'Подключить Яндекс Музыку', exact: true }).click();
  await page.getByText('ABCD', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Открыть страницу Яндекса', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.__yandexOpened), 'https://ya.ru/device');
  await page.getByText('Тест Яндекс · Плюс подключён', { exact: true }).waitFor();
  assert.equal((await readFile(join(directory, 'yandex-session.enc'))).includes('fixture-yandex-token-not-real'), false);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('fixture-yandex-token-not-real')), false);
  await page.getByRole('button', { name: 'Моя музыка', exact: true }).click();
  await page.getByRole('button', { name: 'Яндекс Музыка', exact: true }).click();
  await page.getByRole('button', { name: 'Слушать: Яндекс тест', exact: true }).click();
  await page.locator('footer.player').getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Главная', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('.music-orb')?.dataset.energy) > .01);
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({ path: resolve('test-results/yandex-home.png') });
  await page.locator('footer.player').getByRole('button', { name: 'Пауза', exact: true }).click();
  await page.getByRole('button', { name: 'Текст песни', exact: true }).click();
  await page.getByText('Текст Яндекса для проверки', { exact: true }).waitFor();
  assert.equal(await page.locator('.visualizer.with-lyrics').count(), 1);
  await page.getByRole('button', { name: 'Закрыть текст песни', exact: true }).click();
  await page.getByRole('button', { name: 'Убрать лайк с текущей песни', exact: true }).click();
  await page.getByRole('button', { name: 'Мне нравится текущая песня', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Мне нравится текущая песня', exact: true }).click();
  await page.getByRole('button', { name: 'Убрать лайк с текущей песни', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Плейлисты', exact: true }).click();
  await page.locator('.playlist-card').filter({ hasText: 'Плейлист Яндекса' }).click();
  await page.getByRole('button', { name: 'Исполнитель Яндекса', exact: true }).click();
  await page.getByRole('heading', { name: 'Исполнитель Яндекса', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Открыть альбомы исполнителя', exact: true }).click();
  await page.locator('.playlist-card').filter({ hasText: 'Альбом Яндекса' }).click();
  await page.getByRole('button', { name: 'Яндекс тест', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Поиск', exact: true }).click();
  await page.getByLabel('Поиск по Яндекс Музыке', { exact: true }).fill('Яндекс тест');
  await page.getByLabel('Поиск по Яндекс Музыке', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Яндекс тест', exact: true }).waitFor();
  await page.screenshot({ path: resolve('test-results/yandex-search.png') });
  await page.getByRole('button', { name: 'Действия: Яндекс тест', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить в UniMusic', exact: true }).click();
  await page.getByLabel('Новый плейлист', { exact: true }).fill('Общая подборка');
  await page.getByRole('button', { name: 'Создать и добавить', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Добавлено в UniMusic' }).waitFor();
  await page.evaluate(async () => {
    const r = await window.unimusic.unified({ type: 'list' });
    if (!r.ok) throw new Error(r.error);
    const added = await window.unimusic.unified({ type: 'add', id: r.data[0].id, tracks: [{ source: 'vk', id: 17, ownerId: 0, title: 'VK тест', artist: 'Исполнитель VK', duration: 30, url: '', restricted: false }] });
    if (!added.ok) throw new Error(added.error);
  });
  await page.getByRole('button', { name: 'Моя музыка', exact: true }).click();
  await page.getByRole('button', { name: 'UniMusic', exact: true }).click();
  await page.locator('.playlist-card').filter({ hasText: 'Общая подборка' }).click();
  assert.equal(await page.locator('.unified-track').count(), 2);
  await page.screenshot({ path: resolve('test-results/unified-playlist.png') });
  await page.getByRole('button', { name: 'Убрать из плейлиста: VK тест', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.unified-track').length === 1);
  await page.getByRole('button', { name: 'Яндекс Музыка', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Моя волна', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Главная', exact: true }).click();
  await page.getByRole('button', { name: 'Включить Мою волну', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.wave-launch')?.classList.contains('is-leaving') && Number(getComputedStyle(document.querySelector('.wave-launch')).opacity) < .05);
  await page.locator('footer.player').getByRole('button', { name: 'Пауза', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Не рекомендовать текущую песню', exact: true }).click();
  await page.locator('.now-playing strong').filter({ hasText: 'Вторая песня волны' }).waitFor();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.orb-previous')).opacity === '0');
  await page.locator('.orb-disc').hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.orb-previous')).opacity === '1');
  const disc = await page.locator('.orb-disc').boundingBox();
  for (const selector of ['.orb-previous', '.orb-next']) {
    const button = await page.locator(selector).boundingBox();
    assert.ok(button.x >= disc.x && button.y >= disc.y && button.x + button.width <= disc.x + disc.width && button.y + button.height <= disc.y + disc.height, 'Track controls stay inside the cover circle');
  }
  await page.getByRole('button', { name: 'Предыдущий трек у Orbs', exact: true }).click();
  await page.locator('.now-playing strong').filter({ hasText: 'Яндекс тест' }).waitFor();
  await page.getByRole('button', { name: 'Следующий трек у Orbs', exact: true }).click();
  await page.locator('.now-playing strong').filter({ hasText: 'Вторая песня волны' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.caption-stack .is-previous'));
  await page.locator('.orb-disc').hover();
  await page.screenshot({ path: resolve('test-results/wave-home.png') });
  await app.evaluate(() => { globalThis.__yandexPreview = true; });
  const preview = await page.evaluate(() => window.unimusic.resolveTrack({ source: 'yandex', id: 17, ownerId: 0, title: 'Яндекс тест', artist: 'Test', duration: 30, url: '', restricted: false }, true));
  assert.equal(preview.ok, false); assert.equal(preview.code, 402);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Отключить Яндекс Музыку', exact: true }).click();
  await page.getByRole('button', { name: 'Подключить Яндекс Музыку', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.unimusic.yandexSession())).data, null);
  assert.deepEqual(errors, []);
  console.log('PASS: isolated Yandex device login, encrypted token, library, favorite actions, artist/album/playlist browsing, search, real PCM/Orbs, preview rejection and logout.');
} finally {
  await app.close();
  assert.ok(directory.startsWith(join(tmpdir(), 'unimusic-yandex-')));
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}
