#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <node_api.h>
#include <sqlite3ext.h>
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef _WIN32
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <pthread.h>
#include <dlfcn.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif
#endif

/* SQLite can load this extension in multiple worker environments. Publish its
 * immutable API table once, without the usual writable global extension macro.
 * A second SQLite implementation in one process is deliberately unsupported. */
#ifdef _WIN32
#include <windows.h>
static PVOID volatile shared_api = NULL;
static const sqlite3_api_routines *read_api(void) {
  return (const sqlite3_api_routines *)InterlockedCompareExchangePointer(&shared_api, NULL, NULL);
}
static int publish_api(const sqlite3_api_routines *api) {
  PVOID previous = InterlockedCompareExchangePointer(&shared_api, (PVOID)api, NULL);
  return previous == NULL || previous == (PVOID)api;
}
#else
#include <stdatomic.h>
static _Atomic(const sqlite3_api_routines *) shared_api = NULL;
static const sqlite3_api_routines *read_api(void) {
  return atomic_load_explicit(&shared_api, memory_order_acquire);
}
static int publish_api(const sqlite3_api_routines *api) {
  const sqlite3_api_routines *expected = NULL;
  return atomic_compare_exchange_strong_explicit(&shared_api, &expected, api,
             memory_order_acq_rel, memory_order_acquire) || expected == api;
}
#endif
#define sqlite3_api read_api()

static int process_main_thread(void) {
#ifdef __APPLE__
  return pthread_main_np() != 0;
#elif defined(__linux__)
  return (pid_t)syscall(SYS_gettid) == getpid();
#else
  return 0;
#endif
}

/* Admission is process state, even if the first importer is a worker. Keep
 * this exact loaded image resident: unloading the last worker's addon must not
 * reset claims before SQLite cleanup or an unobserved connection close. */
static int retain_module_image(void) {
#ifdef _WIN32
  HMODULE module;
  return GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_PIN,
                           (LPCSTR)&retain_module_image, &module) != 0;
#else
  static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
  static void *resident = NULL;
  if (pthread_mutex_lock(&mutex) != 0) return 0;
  if (resident == NULL) {
    Dl_info info;
    if (dladdr((const void *)&retain_module_image, &info) != 0)
      resident = dlopen(info.dli_fname, RTLD_NOW | RTLD_LOCAL);
  }
  int retained = resident != NULL;
  pthread_mutex_unlock(&mutex);
  return retained;
#endif
}

typedef struct {
  int fd;
} FileLease;

/* POSIX record locks belong to a process. Keep one inaccessible descriptor and
 * reject a second lease; closing an alias must not silently release its locks. */
static FileLease *active_lease = NULL;
/* One descriptor-free admission count, not a file registry or ownership
 * history. UINT64_MAX reserves a family; other values count actual ordinary
 * connections, including workers. CAS orders admission before any file opens. */
#ifdef _WIN32
static volatile LONG64 admission = 0;
static uint64_t admission_read(void) {
  return (uint64_t)InterlockedCompareExchange64(&admission, 0, 0);
}
static int admission_exchange(uint64_t *expected, uint64_t desired) {
  uint64_t previous = (uint64_t)InterlockedCompareExchange64(
      &admission, (LONG64)desired, (LONG64)*expected);
  if (previous == *expected) return 1;
  *expected = previous;
  return 0;
}
#else
static _Atomic(uint64_t) admission = 0;
static uint64_t admission_read(void) {
  return atomic_load_explicit(&admission, memory_order_acquire);
}
static int admission_exchange(uint64_t *expected, uint64_t desired) {
  return atomic_compare_exchange_strong_explicit(
      &admission, expected, desired, memory_order_acq_rel, memory_order_acquire);
}
#endif
static void release_family_admission(void) {
  uint64_t reserved = UINT64_MAX;
  admission_exchange(&reserved, 0);
}

static napi_value fail(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
  return NULL;
}

static void finalize_lease(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  /* Only a main-thread environment can create the external. If an unsupported
   * embedder finalizes elsewhere, retaining a descriptor is safer than closing
   * an alias and releasing another environment's process locks. */
  if (!process_main_thread()) return;
  FileLease *lease = data;
  int closed = 1;
#ifndef _WIN32
  if (lease->fd >= 0) closed = close(lease->fd) == 0;
#endif
  if (active_lease == lease) {
    active_lease = NULL;
    /* Ambiguous close failure poisons admission instead of reusing an fd. */
    if (closed) release_family_admission();
  }
  free(lease);
}

static FileLease *lease_argument(napi_env env, napi_value value) {
  FileLease *lease = NULL;
  if (napi_get_value_external(env, value, (void **)&lease) != napi_ok ||
      lease == NULL || lease != active_lease || lease->fd < 0) {
    fail(env, "MITZO_OWNER_UNAVAILABLE", "Original open file lease required");
    return NULL;
  }
  return lease;
}

/* No descriptor is opened here. Reject another environment/family before JS
 * examines metadata: even a malformed metadata alias may be a live DB/SHM fd. */
static napi_value assert_lease_admission(napi_env env, napi_callback_info info) {
  (void)info;
  if (!process_main_thread())
    return fail(env, "MITZO_OWNER_UNSUPPORTED", "Owner leases require the process main thread");
  uint64_t observed = admission_read();
  if (observed == UINT64_MAX)
    return fail(env, "MITZO_OWNER_BUSY", "A retained owner lease is already open");
  if (observed != 0)
    return fail(env, "MITZO_OWNER_BUSY", "Actual ordinary SQLite connections remain open");
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner admission check failed");
  return result;
}

static napi_value reserve_family(napi_env env, napi_callback_info info) {
  if (assert_lease_admission(env, info) == NULL) return NULL;
  FileLease *lease = calloc(1, sizeof(*lease));
  if (lease == NULL) return fail(env, "MITZO_OWNER_UNAVAILABLE", "Allocation failed");
  lease->fd = -1; /* No FD exists until authenticated metadata selects the real lease. */
  napi_value result;
  if (napi_create_external(env, lease, finalize_lease, NULL, &result) != napi_ok) {
    free(lease);
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner reservation allocation failed");
  }
  uint64_t expected = 0;
  if (!admission_exchange(&expected, UINT64_MAX))
    return fail(env, "MITZO_OWNER_BUSY", "SQLite admission changed before reservation");
  active_lease = lease;
  return result;
}

static napi_value open_reserved_lease(napi_env env, napi_callback_info info) {
  if (!process_main_thread())
    return fail(env, "MITZO_OWNER_UNSUPPORTED", "Owner leases require the process main thread");
#ifdef _WIN32
  (void)info;
  return fail(env, "MITZO_OWNER_UNSUPPORTED", "Retained owner locking is unsupported");
#else
  size_t argc = 2, length = 0;
  napi_value args[2], result;
  FileLease *lease = NULL;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_external(env, args[0], (void **)&lease) != napi_ok ||
      lease == NULL || lease != active_lease || lease->fd != -1 ||
      napi_get_value_string_utf8(env, args[1], NULL, 0, &length) != napi_ok ||
      length == 0 || length > 32768)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Original owner reservation and exact path required");
  char *filename = calloc(length + 1, 1);
  if (filename == NULL) return fail(env, "MITZO_OWNER_UNAVAILABLE", "Allocation failed");
  if (napi_get_value_string_utf8(env, args[1], filename, length + 1, &length) != napi_ok ||
      strlen(filename) != length) {
    free(filename);
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Exact owner exclusion path required");
  }
  int fd = open(filename, O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  free(filename);
  if (fd < 0) return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner exclusion file unavailable");
  struct stat observed;
  if (fstat(fd, &observed) != 0 || !S_ISREG(observed.st_mode)) {
    close(fd);
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner exclusion file is not regular");
  }
  lease->fd = fd;
  napi_get_undefined(env, &result);
  return result;
#endif
}

typedef struct { int active; } ConnectionLifetime;
static const napi_type_tag connection_lifetime_tag = {
  UINT64_C(0x9c1ba3f0175ac263), UINT64_C(0xb30aab1c1f7a40d9)
};
static void finalize_connection_lifetime(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  /* GC cannot prove that an exposed SQLite object actually closed. An unreleased
   * claim therefore keeps admission denied until process exit. No FD is owned. */
  free(data);
}
static napi_value retain_unqualified_connection(napi_env env, napi_callback_info info) {
  (void)info;
  ConnectionLifetime *claim = calloc(1, sizeof(*claim));
  if (claim == NULL) return fail(env, "MITZO_OWNER_UNAVAILABLE", "Allocation failed");
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_type_tag_object(env, result, &connection_lifetime_tag) != napi_ok ||
      napi_wrap(env, result, claim, finalize_connection_lifetime, NULL, NULL) != napi_ok) {
    free(claim);
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Connection lifetime allocation failed");
  }
  uint64_t observed = admission_read();
  do {
    if (observed == UINT64_MAX)
      return fail(env, "MITZO_OWNER_BUSY", "Retained family excludes ordinary connection admission");
    if (observed == UINT64_MAX - 1)
      return fail(env, "MITZO_OWNER_UNAVAILABLE", "Connection lifetime limit reached");
  } while (!admission_exchange(&observed, observed + 1));
  claim->active = 1;
  return result;
}
static napi_value release_unqualified_connection(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], result;
  bool tagged = false;
  ConnectionLifetime *claim = NULL;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_check_object_type_tag(env, args[0], &connection_lifetime_tag, &tagged) != napi_ok ||
      !tagged || napi_unwrap(env, args[0], (void **)&claim) != napi_ok ||
      claim == NULL || !claim->active)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Original open connection lifetime required");
  uint64_t observed = admission_read();
  do {
    if (observed == 0 || observed == UINT64_MAX)
      return fail(env, "MITZO_OWNER_UNAVAILABLE", "Connection lifetime count unavailable");
  } while (!admission_exchange(&observed, observed - 1));
  claim->active = 0;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value lock_lease(napi_env env, napi_callback_info info) {
  if (!process_main_thread())
    return fail(env, "MITZO_OWNER_UNSUPPORTED", "Owner leases require the process main thread");
  size_t argc = 2;
  napi_value args[2], result;
  int32_t mode;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, args[1], &mode) != napi_ok || mode < 0 || mode > 2)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Exact retained lock operation required");
  FileLease *lease = lease_argument(env, args[0]);
  if (lease == NULL) return NULL;
#ifdef _WIN32
  return fail(env, "MITZO_OWNER_UNSUPPORTED", "Retained owner locking is unsupported");
#else
  struct flock lock;
  memset(&lock, 0, sizeof(lock));
  lock.l_type = mode == 0 ? F_RDLCK : mode == 1 ? F_WRLCK : F_UNLCK;
  lock.l_whence = SEEK_SET;
  if (fcntl(lease->fd, F_SETLK, &lock) != 0)
    return fail(env, errno == EACCES || errno == EAGAIN ? "MITZO_OWNER_BUSY" : "MITZO_OWNER_UNAVAILABLE",
                "Retained file exclusion unavailable");
  napi_get_undefined(env, &result);
  return result;
#endif
}

static napi_value close_lease(napi_env env, napi_callback_info info) {
  if (!process_main_thread())
    return fail(env, "MITZO_OWNER_UNSUPPORTED", "Owner leases require the process main thread");
  size_t argc = 1;
  napi_value args[1], result;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Original owner lease required");
  FileLease *lease = NULL;
  if (napi_get_value_external(env, args[0], (void **)&lease) != napi_ok ||
      lease == NULL || lease != active_lease || lease->fd < -1)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Original owner lease or reservation required");
  int fd = lease->fd;
  lease->fd = -2;
  active_lease = NULL;
#ifndef _WIN32
  if (fd >= 0 && close(fd) != 0)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner lease close failed; admission retained");
#else
  (void)fd;
#endif
  release_family_admission();
  napi_get_undefined(env, &result);
  return result;
}

static napi_value lease_identity(napi_env env, napi_callback_info info) {
  if (!process_main_thread())
    return fail(env, "MITZO_OWNER_UNSUPPORTED", "Owner leases require the process main thread");
  size_t argc = 1;
  napi_value args[1], result;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Original owner lease required");
  FileLease *lease = lease_argument(env, args[0]);
  if (lease == NULL) return NULL;
#ifdef _WIN32
  return fail(env, "MITZO_OWNER_UNSUPPORTED", "Retained owner locking is unsupported");
#else
  struct stat observed;
  if (fstat(lease->fd, &observed) != 0 || !S_ISREG(observed.st_mode))
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Original owner descriptor unavailable");
  char device[64], inode[64];
  snprintf(device, sizeof(device), "%ju", (uintmax_t)observed.st_dev);
  snprintf(inode, sizeof(inode), "%ju", (uintmax_t)observed.st_ino);
  napi_value value;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, device, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, result, "device", value) != napi_ok ||
      napi_create_string_utf8(env, inode, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, result, "inode", value) != napi_ok)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Original descriptor observation failed");
  return result;
#endif
}

static void current_file(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  sqlite3 *database = sqlite3_user_data(context);
  int moved = 1;
  int code = sqlite3_file_control(database, "main", SQLITE_FCNTL_HAS_MOVED, &moved);
  if (code != SQLITE_OK) {
    sqlite3_result_error(context, "Actual SQLite file observation unsupported", -1);
    return;
  }
  sqlite3_result_int(context, moved == 0);
}

#ifdef _WIN32
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
int sqlite3_mitzofileowner_init(sqlite3 *database, char **error,
                              const sqlite3_api_routines *api) {
  (void)error;
  if (api == NULL || database == NULL || !publish_api(api)) return SQLITE_MISUSE;
  return sqlite3_create_function_v2(database, "mitzo_file_owner_current", 0,
      SQLITE_UTF8 | SQLITE_DIRECTONLY, database, current_file, NULL, NULL, NULL);
}

static napi_value initialize(napi_env env, napi_value exports) {
  if (!retain_module_image())
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Process admission image retention failed");
  /* Ordinary connections are supported in workers and on platforms where
   * qualified main-thread leases are unsupported. Lease operations still deny. */
  napi_property_descriptor methods[] = {
      {"assertLeaseAdmission", NULL, assert_lease_admission, NULL, NULL, NULL, napi_default, NULL},
      {"reserveFamily", NULL, reserve_family, NULL, NULL, NULL, napi_default, NULL},
      {"openReservedLease", NULL, open_reserved_lease, NULL, NULL, NULL, napi_default, NULL},
      {"retainUnqualifiedConnection", NULL, retain_unqualified_connection, NULL, NULL, NULL, napi_default, NULL},
      {"releaseUnqualifiedConnection", NULL, release_unqualified_connection, NULL, NULL, NULL, napi_default, NULL},
      {"lockLease", NULL, lock_lease, NULL, NULL, NULL, napi_default, NULL},
      {"closeLease", NULL, close_lease, NULL, NULL, NULL, napi_default, NULL},
      {"leaseIdentity", NULL, lease_identity, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner helper initialization failed");
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
