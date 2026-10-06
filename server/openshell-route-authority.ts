import { isDeepStrictEqual } from 'node:util';

/** Per-turn model selection is mutable; account/provider/grant authority is not. */
export function sameOpenShellRouteAuthority(left: { model: string }, right: { model: string }) {
  return isDeepStrictEqual({ ...left, model: undefined }, { ...right, model: undefined });
}
