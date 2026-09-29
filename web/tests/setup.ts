import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

// Set up fake-indexeddb as globals
globalThis.indexedDB = new IDBFactory()
globalThis.IDBKeyRange = IDBKeyRange
