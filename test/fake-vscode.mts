// What of VS Code's API the extension's editor uses, played in memory: documents, tabs and the diff command — enough
// to see a diff shown, changed by the owner, answered and closed, without VS Code.

type Listener<T> = (value: T) => void;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return new Disposable(() => (this.listeners = this.listeners.filter((other) => other !== listener)));
  };
  fire(value: T) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

export class Disposable {
  private readonly done: () => void;
  constructor(done: () => void) {
    this.done = done;
  }
  dispose() {
    this.done();
  }
}

export class Uri {
  readonly scheme: string;
  readonly path: string;
  constructor(scheme: string, path: string) {
    this.scheme = scheme;
    this.path = path;
  }
  static from(parts: { scheme: string; path: string }) {
    return new Uri(parts.scheme, parts.path);
  }
  static file(path: string) {
    return new Uri("file", path);
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}:${this.path}`;
  }
}

export const FileType = { File: 1 };
export const FileSystemError = {
  FileNotFound: (uri: Uri) => new Error(`not found ${uri}`),
  NoPermissions: (uri: Uri) => new Error(`no permissions ${uri}`),
};

export class TabInputText {
  readonly uri: Uri;
  constructor(uri: Uri) {
    this.uri = uri;
  }
}

export class TabInputTextDiff {
  readonly original: Uri;
  readonly modified: Uri;
  constructor(original: Uri, modified: Uri) {
    this.original = original;
    this.modified = modified;
  }
}

/** A document VS Code holds: its text as the owner left it, saved or not. */
export class Document {
  readonly uri: Uri;
  text: string;
  isDirty = false;
  isClosed = false;
  private readonly saveTo?: (text: string) => void;
  constructor(uri: Uri, text: string, saveTo?: (text: string) => void) {
    this.uri = uri;
    this.text = text;
    this.saveTo = saveTo;
  }
  getText() {
    return this.text;
  }
  async save() {
    this.saveTo?.(this.text);
    this.isDirty = false;
    return true;
  }
}

interface Provider {
  provideTextDocumentContent?: (uri: Uri) => string;
  readFile?: (uri: Uri) => Uint8Array;
  writeFile?: (uri: Uri, bytes: Uint8Array) => void;
}

const providers = new Map<string, Provider>();
const tabsChanged = new EventEmitter<{ opened: unknown[]; closed: Tab[]; changed: unknown[] }>();

interface Tab {
  input: unknown;
  isDirty: boolean;
}

const group = { tabs: [] as Tab[], activeTab: undefined as Tab | undefined };

export const said: string[] = [];
export const contextKeys = new Map<string, unknown>();

export const workspace = {
  textDocuments: [] as Document[],
  registerTextDocumentContentProvider(scheme: string, provider: Provider) {
    providers.set(scheme, provider);
    return new Disposable(() => providers.delete(scheme));
  },
  registerFileSystemProvider(scheme: string, provider: Provider) {
    providers.set(scheme, provider);
    return new Disposable(() => providers.delete(scheme));
  },
};

/** Opens `uri` as VS Code would, from its scheme's provider. */
function document(uri: Uri): Document {
  const found = workspace.textDocuments.find((open) => open.uri.toString() === uri.toString());
  if (found) {
    return found;
  }
  const provider = providers.get(uri.scheme);
  const text = provider?.provideTextDocumentContent
    ? provider.provideTextDocumentContent(uri)
    : new TextDecoder().decode(provider?.readFile?.(uri));
  const opened = new Document(uri, text, provider?.writeFile
    ? (saved) => provider.writeFile?.(uri, new TextEncoder().encode(saved))
    : undefined);
  workspace.textDocuments.push(opened);
  return opened;
}

export const window = {
  activeTextEditor: undefined,
  visibleTextEditors: [] as unknown[],
  onDidChangeActiveTextEditor: new EventEmitter<unknown>().event,
  tabGroups: {
    get all() {
      return [group];
    },
    get activeTabGroup() {
      return group;
    },
    onDidChangeTabs: tabsChanged.event,
    async close(tab: Tab) {
      if (tab.isDirty) {
        throw new Error("VS Code would ask to save");
      }
      group.tabs = group.tabs.filter((other) => other !== tab);
      if (group.activeTab === tab) {
        group.activeTab = group.tabs[0];
      }
      tabsChanged.fire({ opened: [], closed: [tab], changed: [] });
      return true;
    },
  },
  showInformationMessage: async (message: string) => {
    said.push(message);
    return undefined;
  },
  showWarningMessage: async (message: string) => {
    said.push(message);
    return undefined;
  },
};

export const languages = { getDiagnostics: () => [] };

export const commands = {
  async executeCommand(command: string, ...args: unknown[]) {
    if (command === "setContext") {
      contextKeys.set(args[0] as string, args[1]);
    } else if (command === "vscode.diff") {
      const [left, right] = args as [Uri, Uri];
      document(left);
      const changing = document(right);
      const tab: Tab = {
        input: new TabInputTextDiff(left, right),
        get isDirty() {
          return changing.isDirty;
        },
      };
      group.tabs.push(tab);
      group.activeTab = tab;
    }
  },
};

/** The owner types into the right side of the diff in front. */
export function ownerTypes(text: string) {
  const input = group.activeTab?.input as TabInputTextDiff;
  const changing = workspace.textDocuments.find((open) => open.uri.toString() === input.modified.toString());
  if (!changing) {
    throw new Error("no right side");
  }
  changing.text = text;
  changing.isDirty = true;
}

/** The owner closes the tab in front with its ×. */
export async function ownerCloses() {
  const tab = group.activeTab;
  if (tab) {
    await window.tabGroups.close(tab);
  }
}

export function tabs() {
  return group.tabs.length;
}

/** The owner drags the tab in front to another group: VS Code says it closed where it was, and it lives on. */
export function ownerMoves() {
  const tab = group.activeTab;
  if (tab) {
    tabsChanged.fire({ opened: [], closed: [tab], changed: [] });
  }
}
