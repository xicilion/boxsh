/*
 * bootstrap_probe_darwin.c — registers a Mach bootstrap service and reports
 * whether the kernel allowed it.
 *
 * The macOS sandbox profile lets Chromium-family browsers publish (and look
 * up) their per-process Mach rendezvous ports, scoped to a few bundle name
 * prefixes.  This probe exists to prove that the grant is scoped: a name under
 * an allowed prefix can be registered, and everything else — in particular
 * anything that could shadow a system service, like com.apple.* — cannot.
 *
 * Usage: bootstrap_probe_darwin <service-name>
 *   exit 0  service registered (allowed by the sandbox)
 *   exit 1  registration denied
 *   exit 2  could not read our own bootstrap port
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <mach/mach.h>
#include <servers/bootstrap.h>

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <service-name>\n", argv[0]);
        return 2;
    }

    mach_port_t bootstrap_port = MACH_PORT_NULL;
    kern_return_t kr = task_get_bootstrap_port(mach_task_self(), &bootstrap_port);
    if (kr != KERN_SUCCESS || bootstrap_port == MACH_PORT_NULL) {
        fprintf(stderr, "no bootstrap port: %s\n", mach_error_string(kr));
        return 2;
    }

    mach_port_t service_port = MACH_PORT_NULL;
    kr = bootstrap_check_in(bootstrap_port, argv[1], &service_port);
    if (kr == KERN_SUCCESS) {
        printf("registered %s\n", argv[1]);
        return 0;
    }

    printf("denied %s: %s (%d)\n", argv[1], mach_error_string(kr), (int)kr);
    return 1;
}
