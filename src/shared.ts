export type MusicSource = "vk" | "yandex";
export interface UpdateState {
  status: "idle" | "checking" | "downloading" | "ready" | "current" | "error" | "disabled";
  currentVersion: string;
  version?: string;
  progress?: number;
  error?: string;
}
export interface UnifiedPlaylist { id: string; title: string; tracks: Track[] }
export type UnifiedAction = { type: "list" } | { type: "create"; title: string; tracks?: Track[] } | { type: "rename"; id: string; title: string } | { type: "delete"; id: string } | { type: "add" | "remove"; id: string; tracks: Track[] };
export interface YandexAccount extends Profile { plus: boolean }
export interface YandexAuthState { step: "idle" | "waiting" | "complete"; code?: string; url?: string; interval?: number; profile?: YandexAccount }
export interface Profile {
  id: number;
  firstName: string;
  lastName: string;
  avatar?: string;
}

export interface Track {
  id: number;
  ownerId: number;
  title: string;
  artist: string;
  duration: number;
  url: string;
  cover?: string;
  album?: string;
  accessKey?: string;
  restricted: boolean;
  artists?: Artist[];
  albumRef?: MusicReference;
  lyricsId?: number;
  genre?: number;
  date?: number;
  localId?: string;
  source?: "vk" | "yandex" | "local";
  saved?: boolean;
  disliked?: boolean;
  folder?: string;
}

export interface MusicReference { source?: MusicSource | "local"; kind?: "album"; id: number; ownerId: number; accessKey?: string }
export interface Artist { id: string; name: string; cover?: string }
export interface Playlist {
  source?: MusicSource;
  id: number;
  ownerId: number;
  title: string;
  description: string;
  count: number;
  cover?: string;
  accessKey?: string;
  original?: MusicReference;
  year?: number;
  artist?: string;
}

export interface SearchFilters {
  type?: "tracks" | "playlists" | "artists";
  own?: boolean;
  performer?: boolean;
  lyrics?: boolean;
  autocomplete?: boolean;
  sort?: 0 | 1 | 2;
}
export interface BrowseRequest {
  source?: MusicSource;
  kind: "library" | "playlist" | "search" | "artist" | "recommendations" | "popular" | "catalog" | "section" | "block" | "local";
  offset?: number;
  query?: string;
  playlist?: MusicReference;
  track?: MusicReference;
  artistId?: string;
  sectionId?: string;
  blockId?: string;
  cursor?: string;
  genre?: number;
  ownerId?: number;
  filters?: SearchFilters;
}
export interface CatalogSection { id: string; title: string; kind: "section" | "block"; cursor?: string }
export interface MusicPage {
  tracks: Track[];
  playlists: Playlist[];
  artists: Artist[];
  sections: CatalogSection[];
  count: number;
  next?: string;
  title?: string;
}
export type LibraryAction = ({ source?: MusicSource } & (
  | { type: "add" | "delete" | "restore" | "dislike" | "undislike" | "reactions"; track: MusicReference }
  | { type: "edit"; track: MusicReference; title: string; artist: string }
  | { type: "reorder"; track: MusicReference; before?: number; after?: number }
  | { type: "createPlaylist"; title: string; description: string }
  | { type: "editPlaylist"; playlist: MusicReference; title: string; description: string }
  | { type: "deletePlaylist" | "followPlaylist" | "clonePlaylist"; playlist: MusicReference }
  | { type: "addToPlaylist" | "removeFromPlaylist"; playlist: MusicReference; tracks: MusicReference[] }));
export interface PlaybackSnapshot {
  queue: Track[];
  currentKey: string;
  position: number;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  order: string[];
  source?: BrowseRequest;
  loaded: number;
  total: number;
}
export interface AppPreferences {
  autoUpdates: boolean;
  preferDownloads: boolean;
  autoCache: boolean;
  legacyAudio: boolean;
  closeToTray: boolean;
  mediaShortcuts: boolean;
  shortcuts: { toggle: string; next: string; previous: string };
  broadcast: boolean;
  listeningEvents: boolean;
  downloadDirectory: string;
  proxyMode: "system" | "direct" | "custom";
  proxyAddress: string;
  equalizer: number[];
}
export interface DownloadEntry {
  id: string;
  track: Track;
  state: "queued" | "downloading" | "complete" | "error" | "cancelled";
  progress: number;
  bytes: number;
  error?: string;
}
export interface OfflineState { entries: DownloadEntry[]; bytes: number; directory: string }
export type OfflineAction =
  | { type: "list" | "import" | "directory" | "clear" }
  | { type: "download"; tracks: Track[]; replace?: boolean }
  | { type: "cancel" | "remove" | "reveal" | "upload"; id: string };
export interface TrackInfo { format: string; bitrate?: number; size?: number; source: string }

export interface Page<T> {
  items: T[];
  count: number;
}
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: number };

export type AuthMethod =
  | "push"
  | "email"
  | "sms"
  | "callreset"
  | "password"
  | "reserve_code"
  | "codegen";
export interface AuthState {
  step: "login" | "methods" | "code" | "password" | "complete";
  methods: AuthMethod[];
  method?: AuthMethod;
  info?: string;
  codeLength?: number;
  profile?: Profile;
}
export type AuthAction =
  | { type: "begin"; login: string }
  | { type: "method"; method: AuthMethod }
  | { type: "code"; code: string }
  | { type: "password"; password: string }
  | { type: "cancel" };

export interface MusicApi {
  updates(action: "status" | "check"): Promise<Result<UpdateState>>;
  onUpdate(callback: (state: UpdateState) => void): () => void;
  unified(action: UnifiedAction): Promise<Result<UnifiedPlaylist[]>>;
  waveFeedback(track: Track, type: "trackStarted" | "trackFinished" | "skip", seconds: number): Promise<Result<null>>;
  yandexSession(): Promise<Result<YandexAccount | null>>;
  yandexAuth(action: "begin" | "poll" | "cancel" | "open" | "logout"): Promise<Result<YandexAuthState>>;
  session(): Promise<Result<Profile | null>>;
  auth(action: AuthAction): Promise<Result<AuthState>>;
  logout(): Promise<Result<null>>;
  tracks(options: {
    offset?: number;
    playlist?: Playlist;
  }): Promise<Result<Page<Track>>>;
  search(query: string, offset?: number): Promise<Result<Page<Track>>>;
  playlists(offset?: number, source?: MusicSource): Promise<Result<Page<Playlist>>>;
  resolveTrack(track: Track, legacy?: boolean): Promise<Result<Track>>;
  prepareTrack(track: Track): Promise<Result<null>>;
  reportPlaybackError(error: { type: string; detail: string; status: number }): Promise<Result<null>>;
  browse(request: BrowseRequest): Promise<Result<MusicPage>>;
  library(action: LibraryAction): Promise<Result<{ track?: Track; playlist?: Playlist }>>;
  lyrics(track: MusicReference): Promise<Result<string>>;
  offline(action: OfflineAction): Promise<Result<OfflineState>>;
  preferences(value?: Partial<AppPreferences>): Promise<Result<AppPreferences>>;
  playback(value?: PlaybackSnapshot | null): Promise<Result<PlaybackSnapshot | null>>;
  trackInfo(track: Track): Promise<Result<TrackInfo>>;
  copyTrack(track: Track, kind: "link" | "text" | "attachment"): Promise<Result<null>>;
  copyText(text: string): Promise<Result<null>>;
  played(track: Track): Promise<Result<null>>;
  diagnostics(): Promise<Result<string>>;
  onCommand(callback: (command: "toggle" | "next" | "previous") => void): () => void;
  window(action: "minimize" | "maximize" | "close"): void;
}

declare global {
  interface Window {
    unimusic?: MusicApi;
  }
}
