import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonFile, durableTrack } from "./state";
import { object, string, VkError } from "./vk";
import type { Track, UnifiedPlaylist } from "../src/shared";

const key = (t: Track) => t.localId ? `local:${t.localId}` : `${t.source}:${t.ownerId}:${t.id}`;
function title(value: unknown) {
  const text = string(value).trim();
  if (!text || text.length > 120) throw new VkError("Название должно содержать от 1 до 120 символов.");
  return text;
}
function tracks(value: unknown): Track[] {
  if (!Array.isArray(value) || value.length > 10000) throw new VkError("Некорректный список треков.");
  return [...new Map(value.map(value => { const t = durableTrack(value); return [key(t), t] as const; })).values()];
}
export class UnifiedStore {
  private pending: Promise<unknown> = Promise.resolve();
  private file: JsonFile<UnifiedPlaylist[]>;
  constructor(private directory: string) { this.file = new JsonFile(directory, "unimusic-playlists.json"); }
  run(value: unknown): Promise<UnifiedPlaylist[]> {
    const task = this.pending.catch(() => {}).then(async () => {
      const a = object(value);
      let data: UnifiedPlaylist[];
      try { data = JSON.parse(await readFile(join(this.directory, "unimusic-playlists.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") data = []; else throw new VkError("Файл плейлистов повреждён или недоступен. Исходный файл сохранён."); }
      if (!Array.isArray(data)) throw new VkError("Не удалось прочитать плейлисты UniMusic.");
      const items = data.map(p => ({ id: string(p.id), title: title(p.title), tracks: tracks(p.tracks) }));
      if (a.type === "list") return items;
      if (a.type === "create") {
        if (items.length >= 500) throw new VkError("Достигнут лимит в 500 плейлистов.");
        items.push({ id: randomUUID(), title: title(a.title), tracks: tracks(a.tracks ?? []) });
      } else {
        const index = items.findIndex(p => p.id === a.id);
        if (index < 0) throw new VkError("Плейлист не найден.");
        const p = items[index];
        if (a.type === "rename") p.title = title(a.title);
        else if (a.type === "delete") items.splice(index, 1);
        else if (a.type === "add") p.tracks = tracks([...p.tracks, ...tracks(a.tracks)]);
        else if (a.type === "remove") { const remove = new Set(tracks(a.tracks).map(key)); p.tracks = p.tracks.filter(t => !remove.has(key(t))); }
        else throw new VkError("Неизвестное действие с плейлистом.");
      }
      await this.file.write(items);
      return items;
    });
    this.pending = task;
    return task;
  }
}
