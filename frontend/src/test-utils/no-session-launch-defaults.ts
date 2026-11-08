/** Legacy route-wiring fixtures begin after an empty defaults read. The actual
 * read/loading/error and draft hydration paths have dedicated hook/page tests. */
export function noSessionLaunchDefaults() {
  return {
    revision: 0,
    configuration: null,
    loading: false,
    saving: false,
    error: '',
    save: async () => false,
    refresh() {},
  };
}
