/* A second Landlock layer restricts all native agent descendants' writes.
 * Gateway upload/verification remains outside this layer. Reads and execution
 * keep the existing OpenShell policy; no task can rewrite the knowledge lane.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#define WRITE_ACCESS (LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | \
 LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | \
 LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | \
 LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | \
 LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | \
 LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE)
static void die(const char *message) { perror(message); exit(1); }
static void allow(int ruleset, const char *path, int directory) {
 int fd = open(path, O_PATH | O_CLOEXEC | O_NOFOLLOW | (directory ? O_DIRECTORY : 0));
 if (fd < 0) die(path);
 struct landlock_path_beneath_attr rule = {
  .parent_fd = fd,
  .allowed_access = directory ? WRITE_ACCESS : LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE,
 };
 if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0) die(path);
 close(fd);
}
int main(int argc, char **argv) {
 if (argc < 2) return 2;
 if (syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) < 3) {
  fprintf(stderr, "Knowledge isolation requires Landlock ABI 3 or newer\n"); return 1;
 }
 const char *state[] = {"/sandbox/.codex", "/sandbox/.cache", "/sandbox/.config", "/sandbox/.local"};
 for (unsigned i=0; i<sizeof(state)/sizeof(state[0]); ++i)
  if (mkdir(state[i], 0700) < 0 && errno != EEXIST) die(state[i]);
 struct landlock_ruleset_attr rules = {.handled_access_fs = WRITE_ACCESS};
 int fd = syscall(__NR_landlock_create_ruleset, &rules, sizeof(rules), 0);
 if (fd < 0) die("landlock_create_ruleset");
 allow(fd, "/sandbox/workspaces/mgmt", 1);
 allow(fd, "/tmp", 1);
 allow(fd, "/dev/null", 0);
 for (unsigned i=0; i<sizeof(state)/sizeof(state[0]); ++i) allow(fd, state[i], 1);
 if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die("no_new_privs");
 if (syscall(__NR_landlock_restrict_self, fd, 0) < 0) die("landlock_restrict_self");
 close(fd);
 execvp(argv[1], &argv[1]);
 die("execvp");
}
