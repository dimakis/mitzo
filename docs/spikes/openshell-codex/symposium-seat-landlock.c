/* Disposable prototype: kernel-enforced native seat HOME and workspace scope.
 * No production caller is wired until the image, gateway, and native tools pass
 * the cross-seat canary. Compile on Linux with gcc -O2 -Wall -Wextra -Werror.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

#define READ_ACCESS (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)
#define WRITE_ACCESS (LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | \
                      LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | \
                      LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | \
                      LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | \
                      LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | \
                      LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE)
#define EXEC_ACCESS LANDLOCK_ACCESS_FS_EXECUTE

static void die(const char *message) {
  perror(message);
  exit(1);
}

static void allow_path(int ruleset, const char *path, __u64 access, int directory) {
  int fd = open(path, O_PATH | O_CLOEXEC | O_NOFOLLOW | (directory ? O_DIRECTORY : 0));
  if (fd < 0) die(path);
  struct landlock_path_beneath_attr rule = {
      .allowed_access = access,
      .parent_fd = fd,
  };
  if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0)
    die(path);
  close(fd);
}

/* Supervisor public certificate files are mounted outside /etc. Grant only
 * regular-file reads: no directory traversal grant, keys, writes or execution.
 * Older/offline images without this optional mount keep their existing scope. */
static void allow_public_ca(int ruleset, const char *path) {
  int fd = open(path, O_PATH | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    if (errno == ENOENT) return;
    die("public supervisor CA");
  }
  struct stat info;
  if (fstat(fd, &info) < 0) die("public supervisor CA stat");
  if (!S_ISREG(info.st_mode)) {
    fprintf(stderr, "public supervisor CA must be a regular file\n");
    exit(1);
  }
  struct landlock_path_beneath_attr rule = {
      .allowed_access = LANDLOCK_ACCESS_FS_READ_FILE,
      .parent_fd = fd,
  };
  if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0)
    die("public supervisor CA rule");
  close(fd);
}

/* The policy authorizes /usr/bin/codex, not an npm script's native child.
 * Build-time validation pins the full ELF hash; startup refuses shim images. */
static void require_native_codex(void) {
  int fd = open("/usr/bin/codex", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) die("canonical native Codex required");
  struct stat info;
  unsigned char header[20];
  if (fstat(fd, &info) < 0 || !S_ISREG(info.st_mode) || info.st_uid != 0 ||
      (info.st_mode & 0022) || !(info.st_mode & 0111) ||
      read(fd, header, sizeof(header)) != (ssize_t)sizeof(header) ||
      memcmp(header, "\177ELF\002\001", 6) != 0 ||
      header[18] != 183 || header[19] != 0) {
    fprintf(stderr, "reviewed canonical Linux arm64 Codex ELF required\n");
    exit(1);
  }
  close(fd);
}

static int valid_home(const char *path) {
  const char *prefix = "/sandbox/.symposium-seats/";
  if (strncmp(path, prefix, strlen(prefix)) != 0) return 0;
  const char *digest = path + strlen(prefix);
  if (strlen(digest) != 64) return 0;
  for (size_t i = 0; i < 64; ++i)
    if (!((digest[i] >= '0' && digest[i] <= '9') ||
          (digest[i] >= 'a' && digest[i] <= 'f'))) return 0;
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 5 || !valid_home(argv[1]) ||
      strcmp(argv[2], "/sandbox/workspaces/mgmt") != 0 ||
      (strcmp(argv[3], "read") != 0 && strcmp(argv[3], "write") != 0)) {
    fprintf(stderr, "invalid Symposium seat scope\n");
    return 2;
  }
  if (!strcmp(argv[4], "/usr/bin/codex") ||
      !strcmp(argv[4], "/usr/local/bin/symposium-subscription-app-server"))
    require_native_codex();
  int abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) {
    fprintf(stderr, "Landlock ABI 3 or newer is required\n");
    return 1;
  }
  int home_fd = open(argv[1], O_PATH | O_CLOEXEC | O_NOFOLLOW | O_DIRECTORY);
  if (home_fd < 0) die("private seat HOME");
  if (mkdirat(home_fd, "tmp", 0700) < 0 && errno != EEXIST) die("private seat tmp");
  int tmp_fd = openat(home_fd, "tmp", O_PATH | O_CLOEXEC | O_NOFOLLOW | O_DIRECTORY);
  if (tmp_fd < 0) die("private seat tmp");
  close(tmp_fd);
  if (mkdirat(home_fd, ".codex", 0700) < 0 && errno != EEXIST) die("private Codex HOME");
  int codex_fd = openat(home_fd, ".codex", O_PATH | O_CLOEXEC | O_NOFOLLOW | O_DIRECTORY);
  if (codex_fd < 0) die("private Codex HOME");
  close(codex_fd);
  close(home_fd);
  char tmp[PATH_MAX];
  char codex_home[PATH_MAX];
  if (snprintf(tmp, sizeof(tmp), "%s/tmp", argv[1]) >= (int)sizeof(tmp) ||
      snprintf(codex_home, sizeof(codex_home), "%s/.codex", argv[1]) >=
          (int)sizeof(codex_home)) {
    fprintf(stderr, "private seat path is too long\n");
    return 1;
  }
  __u64 handled = READ_ACCESS | WRITE_ACCESS | EXEC_ACCESS;
  struct landlock_ruleset_attr rules = { .handled_access_fs = handled };
  int fd = syscall(__NR_landlock_create_ruleset, &rules, sizeof(rules), 0);
  if (fd < 0) die("landlock_create_ruleset");
  allow_path(fd, "/usr", READ_ACCESS | EXEC_ACCESS, 1);
  allow_path(fd, "/opt", READ_ACCESS | EXEC_ACCESS, 1);
  allow_path(fd, "/etc", READ_ACCESS, 1);
  allow_public_ca(fd, "/run/openshell-supervisor-ca/material/ca.crt");
  allow_public_ca(fd, "/run/openshell-supervisor-ca/material/ca-bundle.crt");
  allow_path(fd, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 0);
  allow_path(fd, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE, 0);
  allow_path(fd, argv[1], READ_ACCESS | WRITE_ACCESS | EXEC_ACCESS, 1);
  allow_path(fd, argv[2], READ_ACCESS |
             (strcmp(argv[3], "write") == 0 ? WRITE_ACCESS : 0), 1);
  /* The app-server launcher itself is trusted; its children inherit these rules. */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die("no_new_privs");
  if (syscall(__NR_landlock_restrict_self, fd, 0) < 0) die("landlock_restrict_self");
  close(fd);
  if (setenv("HOME", argv[1], 1) || setenv("TMPDIR", tmp, 1) ||
      setenv("TMP", tmp, 1) || setenv("TEMP", tmp, 1) ||
      setenv("CLAUDE_CODE_TMPDIR", tmp, 1) ||
      setenv("CODEX_HOME", codex_home, 1) ||
      setenv("XDG_CONFIG_HOME", argv[1], 1) ||
      setenv("XDG_STATE_HOME", argv[1], 1) ||
      setenv("XDG_CACHE_HOME", argv[1], 1) ||
      setenv("XDG_DATA_HOME", argv[1], 1) ||
      setenv("XDG_RUNTIME_DIR", argv[1], 1)) die("setenv");
  execvp(argv[4], &argv[4]);
  die("execvp");
}
