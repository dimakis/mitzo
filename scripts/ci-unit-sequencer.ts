import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { selectUnitShard } from './ci-unit-shards.mjs';
import { realpathSync } from 'node:fs';

export default class CiUnitSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]) {
    const { shard, root } = this.ctx.config;
    if (!shard) return files;
    const selected = new Set(
      selectUnitShard(
        files.map((file) => file.moduleId),
        realpathSync(root),
        shard.index,
        shard.count,
        process.env.MITZO_CI_PREPARED_CONSUMERS === '1',
      ),
    );
    return files.filter((file) => selected.has(file.moduleId));
  }
}
