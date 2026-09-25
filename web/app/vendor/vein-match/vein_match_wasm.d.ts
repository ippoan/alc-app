/* tslint:disable */
/* eslint-disable */

export class SearchResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly info: Uint8Array;
    readonly ret: number;
    readonly score0: number;
    readonly score1: number;
    readonly score2: number;
}

export class VeinLibrary {
    free(): void;
    [Symbol.dispose](): void;
    counts(): Uint8Array;
    get_enroll_template_b64(user: number): string | undefined;
    import_temp_b64(user: number, tmpl: string): number;
    last_entry(): number;
    last_user(): number;
    mru(): Uint16Array;
    constructor(n: number);
    saved(): number;
    search_user(chara: Uint8Array, level: number, t8?: number | null): SearchResult;
    search_user_hex(probe: string, level: number, t8?: number | null): SearchResult;
    store(): Uint8Array;
}

export function chara_match(a: Uint8Array, b: Uint8Array, th: number): number;

export function chara_match_hex(a: string, b: string, th: number): number;

export function create_template_b64(charas_hex: string[], group: number): string;

export function logic_version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_searchresult_free: (a: number, b: number) => void;
    readonly __wbg_veinlibrary_free: (a: number, b: number) => void;
    readonly chara_match: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly chara_match_hex: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly create_template_b64: (a: number, b: number, c: number) => [number, number, number, number];
    readonly logic_version: () => [number, number];
    readonly searchresult_info: (a: number) => [number, number];
    readonly searchresult_ret: (a: number) => number;
    readonly searchresult_score0: (a: number) => number;
    readonly searchresult_score1: (a: number) => number;
    readonly searchresult_score2: (a: number) => number;
    readonly veinlibrary_counts: (a: number) => [number, number];
    readonly veinlibrary_get_enroll_template_b64: (a: number, b: number) => [number, number];
    readonly veinlibrary_import_temp_b64: (a: number, b: number, c: number, d: number) => number;
    readonly veinlibrary_last_entry: (a: number) => number;
    readonly veinlibrary_last_user: (a: number) => number;
    readonly veinlibrary_mru: (a: number) => [number, number];
    readonly veinlibrary_new: (a: number) => [number, number, number];
    readonly veinlibrary_saved: (a: number) => number;
    readonly veinlibrary_search_user: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly veinlibrary_search_user_hex: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly veinlibrary_store: (a: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_alloc: () => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
