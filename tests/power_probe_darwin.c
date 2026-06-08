#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/pwr_mgt/IOPMLib.h>
#include <stdio.h>

int main(void) {
    IONotificationPortRef notify_port = NULL;
    io_object_t notifier = IO_OBJECT_NULL;
    io_connect_t root_port = IORegisterForSystemPower(
        NULL,
        &notify_port,
        NULL,
        &notifier
    );

    if (root_port == IO_OBJECT_NULL) {
        return 2;
    }

    if (notifier != IO_OBJECT_NULL) {
        IOObjectRelease(notifier);
    }
    if (notify_port != NULL) {
        IONotificationPortDestroy(notify_port);
    }

    printf("power-probe-ok\n");
    return 0;
}
