#include <errno.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

/* Read-only Darwin peer/process observations. Only the original controller's
 * live capability can authorize a VM; this executable returns no grant. */
static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
    if (*p == '"' || *p == '\\') printf("\\%c", *p);
    else if (*p < 0x20) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
int main(int argc, char **argv) {
  pid_t pid = 0;
  uid_t peer_uid = geteuid();
  gid_t peer_gid = getegid();
  if (argc == 2 && strcmp(argv[1], "peer") == 0) {
    socklen_t length = sizeof(pid);
    if (getsockopt(STDIN_FILENO, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) != 0 ||
        length != sizeof(pid) ||
        getpeereid(STDIN_FILENO, &peer_uid, &peer_gid) != 0 ||
        peer_uid != geteuid()) return 1;
  } else if (argc == 3 && strcmp(argv[1], "process") == 0) {
    errno = 0;
    char *end = NULL;
    long parsed = strtol(argv[2], &end, 10);
    if (errno || !end || *end || parsed < 2 || parsed > INT32_MAX) return 1;
    pid = (pid_t)parsed;
  } else return 1;
  if (pid < 2) return 1;
  struct proc_bsdinfo before = {0}, after = {0};
  char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != (int)sizeof(before) ||
      before.pbi_pid != (uint32_t)pid || before.pbi_uid != geteuid() ||
      proc_pidpath(pid, executable, sizeof(executable)) <= 0 ||
      proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != (int)sizeof(after) ||
      before.pbi_pid != after.pbi_pid || before.pbi_ppid != after.pbi_ppid ||
      before.pbi_uid != after.pbi_uid ||
      before.pbi_start_tvsec != after.pbi_start_tvsec ||
      before.pbi_start_tvusec != after.pbi_start_tvusec) return 1;
  printf("{\"pid\":%u,\"ppid\":%u,\"uid\":%u,\"peerUid\":%u,\"peerGid\":%u,\"kernelBirth\":\"%llu:%llu\",\"executable\":",
    before.pbi_pid, before.pbi_ppid, before.pbi_uid, peer_uid, peer_gid,
    (unsigned long long)before.pbi_start_tvsec,
    (unsigned long long)before.pbi_start_tvusec);
  json_string(executable);
  puts("}");
  return ferror(stdout) ? 1 : 0;
}
