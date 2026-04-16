#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/landlock.h>
#include <linux/prctl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER 0
#endif

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE 0
#endif

#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV 0
#endif

static int landlock_create_ruleset_wrap(const struct landlock_ruleset_attr *attr, size_t size, __u32 flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int landlock_add_rule_wrap(int ruleset_fd, enum landlock_rule_type rule_type, const void *rule_attr, __u32 flags) {
  return (int)syscall(__NR_landlock_add_rule, ruleset_fd, rule_type, rule_attr, flags);
}

static int landlock_restrict_self_wrap(int ruleset_fd, __u32 flags) {
  return (int)syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

static uint64_t handled_fs_rights(void) {
  return LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE |
         LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
         LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
         LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
         LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE |
         LANDLOCK_ACCESS_FS_IOCTL_DEV;
}

static uint64_t readonly_fs_rights(void) {
  return LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
         LANDLOCK_ACCESS_FS_IOCTL_DEV;
}

static int add_path_rule(int ruleset_fd, const char *path, uint64_t rights, uint64_t handled_rights) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT) {
      return 0;
    }
    fprintf(stderr, "code-landlock: open %s: %s\n", path, strerror(errno));
    return -1;
  }

  struct landlock_path_beneath_attr rule = {
      .allowed_access = rights & handled_rights,
      .parent_fd = fd,
  };

  if (landlock_add_rule_wrap(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0) {
    fprintf(stderr, "code-landlock: add rule %s: %s\n", path, strerror(errno));
    close(fd);
    return -1;
  }

  close(fd);
  return 0;
}

static void usage(void) {
  fprintf(stderr, "usage: code-landlock --uid UID --gid GID [--ro PATH] [--rw PATH] -- COMMAND [ARGS...]\n");
}

int main(int argc, char **argv) {
  uid_t uid = 0;
  gid_t gid = 0;
  const char *ro_paths[128];
  const char *rw_paths[128];
  int ro_count = 0;
  int rw_count = 0;
  int command_index = -1;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      command_index = i + 1;
      break;
    } else if (strcmp(argv[i], "--uid") == 0 && i + 1 < argc) {
      uid = (uid_t)strtoul(argv[++i], NULL, 10);
    } else if (strcmp(argv[i], "--gid") == 0 && i + 1 < argc) {
      gid = (gid_t)strtoul(argv[++i], NULL, 10);
    } else if (strcmp(argv[i], "--ro") == 0 && i + 1 < argc && ro_count < 128) {
      ro_paths[ro_count++] = argv[++i];
    } else if (strcmp(argv[i], "--rw") == 0 && i + 1 < argc && rw_count < 128) {
      rw_paths[rw_count++] = argv[++i];
    } else {
      usage();
      return 2;
    }
  }

  if (!uid || !gid || command_index < 0 || command_index >= argc) {
    usage();
    return 2;
  }

  int abi = landlock_create_ruleset_wrap(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) {
    fprintf(stderr, "code-landlock: Landlock is unavailable on this kernel: %s\n", strerror(errno));
    return 126;
  }

  uint64_t handled_rights = handled_fs_rights();
  if (abi < 2) {
    handled_rights &= ~LANDLOCK_ACCESS_FS_REFER;
  }
  if (abi < 3) {
    handled_rights &= ~LANDLOCK_ACCESS_FS_TRUNCATE;
  }
  if (abi < 5) {
    handled_rights &= ~LANDLOCK_ACCESS_FS_IOCTL_DEV;
  }

  struct landlock_ruleset_attr ruleset = {
      .handled_access_fs = handled_rights,
  };

  int ruleset_fd = landlock_create_ruleset_wrap(&ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) {
    fprintf(stderr, "code-landlock: create ruleset: %s\n", strerror(errno));
    return 126;
  }

  for (int i = 0; i < ro_count; i++) {
    if (add_path_rule(ruleset_fd, ro_paths[i], readonly_fs_rights(), handled_rights) < 0) {
      close(ruleset_fd);
      return 126;
    }
  }

  for (int i = 0; i < rw_count; i++) {
    if (add_path_rule(ruleset_fd, rw_paths[i], handled_rights, handled_rights) < 0) {
      close(ruleset_fd);
      return 126;
    }
  }

  if (setgroups(0, NULL) < 0) {
    fprintf(stderr, "code-landlock: clear groups: %s\n", strerror(errno));
    close(ruleset_fd);
    return 126;
  }
  if (setgid(gid) < 0) {
    fprintf(stderr, "code-landlock: setgid: %s\n", strerror(errno));
    close(ruleset_fd);
    return 126;
  }
  if (setuid(uid) < 0) {
    fprintf(stderr, "code-landlock: setuid: %s\n", strerror(errno));
    close(ruleset_fd);
    return 126;
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    fprintf(stderr, "code-landlock: no_new_privs: %s\n", strerror(errno));
    close(ruleset_fd);
    return 126;
  }

  if (landlock_restrict_self_wrap(ruleset_fd, 0) < 0) {
    fprintf(stderr, "code-landlock: restrict self: %s\n", strerror(errno));
    close(ruleset_fd);
    return 126;
  }
  close(ruleset_fd);

  execvp(argv[command_index], &argv[command_index]);
  fprintf(stderr, "code-landlock: exec %s: %s\n", argv[command_index], strerror(errno));
  return 127;
}
