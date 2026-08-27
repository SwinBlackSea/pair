import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class StrategyStore {
  constructor(filePath) {
    this.filePath = resolve(filePath);
    this.items = [];
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("数据文件格式错误");
      this.items = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  all() {
    return structuredClone(this.items);
  }

  get(id) {
    const item = this.items.find((entry) => entry.id === id);
    return item ? structuredClone(item) : null;
  }

  async create(item) {
    this.items.push(structuredClone(item));
    await this.persist();
    return this.get(item.id);
  }

  async update(id, changes) {
    const index = this.items.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    this.items[index] = { ...this.items[index], ...structuredClone(changes) };
    await this.persist();
    return this.get(id);
  }

  async remove(id) {
    const index = this.items.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    await this.persist();
    return true;
  }

  async persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(this.items, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    });
    return this.writeQueue;
  }
}
