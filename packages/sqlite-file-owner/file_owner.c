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

typedef struct {
  int fd;
} FileLease;

/* POSIX record locks belong to a process. Keep one inaccessible descriptor and
 * reject a second lease; closing an alias must not silently release its locks. */
static FileLease *active_lease = NULL;

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
#ifndef _WIN32
  if (lease->fd >= 0) close(lease->fd);
#endif
  if (active_lease == lease) active_lease = NULL;
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

static napi_value open_lease(napi_env env, napi_callback_info info) {
  if (!process_main_thread())
    return fail(env, "MITZO_OWNER_UNSUPPORTED", "Owner leases require the process main thread");
#ifdef _WIN32
  (void)info;
  return fail(env, "MITZO_OWNER_UNSUPPORTED", "Retained owner locking is unsupported");
#else
  size_t argc = 1, length = 0;
  napi_value args[1], result;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_string_utf8(env, args[0], NULL, 0, &length) != napi_ok ||
      length == 0 || length > 32768)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Exact owner exclusion path required");
  if (active_lease != NULL)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "A retained owner lease is already open");
  char *filename = calloc(length + 1, 1);
  if (filename == NULL) return fail(env, "MITZO_OWNER_UNAVAILABLE", "Allocation failed");
  if (napi_get_value_string_utf8(env, args[0], filename, length + 1, &length) != napi_ok) {
    free(filename);
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Exact owner exclusion path required");
  }
  if (strlen(filename) != length) {
    free(filename);
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "NUL in owner exclusion path");
  }
  int fd = open(filename, O_RDWR | O_CLOEXEC | O_NOFOLLOW);
  free(filename);
  if (fd < 0) return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner exclusion file unavailable");
  struct stat observed;
  if (fstat(fd, &observed) != 0 || !S_ISREG(observed.st_mode)) {
    close(fd);
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner exclusion file is not regular");
  }
  FileLease *lease = calloc(1, sizeof(*lease));
  if (lease == NULL) {
    close(fd);
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Allocation failed");
  }
  lease->fd = fd;
  if (napi_create_external(env, lease, finalize_lease, NULL, &result) != napi_ok) {
    close(fd);
    free(lease);
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner lease allocation failed");
  }
  active_lease = lease;
  return result;
#endif
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
  FileLease *lease = lease_argument(env, args[0]);
  if (lease == NULL) return NULL;
  int fd = lease->fd;
  lease->fd = -1;
  active_lease = NULL;
#ifndef _WIN32
  if (close(fd) != 0)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner lease close failed");
#else
  (void)fd;
#endif
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
  if (!process_main_thread())
    return fail(env, "MITZO_OWNER_UNSUPPORTED", "Owner leases require the process main thread");
  napi_property_descriptor methods[] = {
      {"openLease", NULL, open_lease, NULL, NULL, NULL, napi_default, NULL},
      {"lockLease", NULL, lock_lease, NULL, NULL, NULL, napi_default, NULL},
      {"closeLease", NULL, close_lease, NULL, NULL, NULL, napi_default, NULL},
      {"leaseIdentity", NULL, lease_identity, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok)
    return fail(env, "MITZO_OWNER_UNAVAILABLE", "Owner helper initialization failed");
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
