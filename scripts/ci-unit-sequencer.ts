import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { selectUnitShard } from './ci-unit-shards.mjs';

export default class CiUnitSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]) {
    const { shard, root } = this.ctx.config;
    if (!shard) return files;
    const selected = new Set(
      selectUnitShard(
        files.map((file) => file.moduleId),
        root,
        shard.index,
        shard.count,
      ),
    );
    return files.filter((file) => selected.has(file.moduleId));
  }
}
