#import <UIKit/UIKit.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/utsname.h>
#include <objc/message.h>
#ifdef PLAYBRIDGE_WITH_HELPER
extern int BridgeAnswer(void);
#endif
@interface DemoDelegate : UIResponder <UIApplicationDelegate>
@property(strong, nonatomic) UIWindow *window;
@end
@implementation DemoDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  UIViewController *controller = [UIViewController new];
  controller.view.backgroundColor = UIColor.orangeColor;
  UILabel *label = [[UILabel alloc] initWithFrame:CGRectMake(40, 100, 600, 120)];
  label.text = @"PlayBridge direct IPA runtime";
  label.font = [UIFont boldSystemFontOfSize:24];
  [controller.view addSubview:label]; self.window.rootViewController = controller;
  [self.window makeKeyAndVisible]; return YES;
}
@end
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--self-test") == 0) {
    @autoreleasepool { printf("UIKit loaded: %s\n", NSClassFromString(@"UIApplication") ? "YES" : "NO"); }
#ifdef PLAYBRIDGE_WITH_HELPER
    printf("Nested framework answer: %d\n", BridgeAnswer());
#endif
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "--check-spoofing") == 0) {
    @autoreleasepool {
      char machine[128] = {0};
      size_t len = sizeof(machine);
      sysctlbyname("hw.machine", machine, &len, NULL, 0);
      struct utsname uts;
      uname(&uts);
      BOOL catalyst = [NSProcessInfo.processInfo isMacCatalystApp];
      BOOL iosOnMac = NO;
      SEL isiOSAppOnMacSel = NSSelectorFromString(@"isiOSAppOnMac");
      if ([NSProcessInfo.processInfo respondsToSelector:isiOSAppOnMacSel]) {
        iosOnMac = ((BOOL (*)(id, SEL))objc_msgSend)(NSProcessInfo.processInfo, isiOSAppOnMacSel);
      }
      printf("machine: %s\n", machine);
      printf("uts.machine: %s\n", uts.machine);
      printf("catalyst: %s\n", catalyst ? "YES" : "NO");
      printf("iosOnMac: %s\n", iosOnMac ? "YES" : "NO");
      printf("model: %s\n", [UIDevice.currentDevice.model UTF8String]);
      printf("idiom: %ld\n", (long)UIDevice.currentDevice.userInterfaceIdiom);
      fflush(stdout);
      // The input layer swallows exit() until the app is quitting; say so, or returning from main cannot end the process.
      [NSNotificationCenter.defaultCenter postNotificationName:UIApplicationWillTerminateNotification object:nil];
    }
    return 0;
  }
  if (argc > 2 && strcmp(argv[1], "--check-exit") == 0) {
    // Through a pointer: exit() is declared noreturn, so a direct call lets the compiler drop the code after it,
    // and the input layer DOES return from it during play (games reach exit through tables / dlsym the same way).
    void (*volatile call_exit)(int) = exit;
    setvbuf(stdout, NULL, _IONBF, 0);
    const char *mode = argv[2];
    if (strcmp(mode, "quit") == 0) {
      call_exit(3);  // anti-cheat style exit in the middle of a game: the input layer must swallow it
      printf("exit blocked\n");
      [NSNotificationCenter.defaultCenter postNotificationName:UIApplicationWillTerminateNotification object:nil];
      call_exit(7);  // the game's own exit while quitting: must go through
      printf("NOT REACHED\n");
      return 1;
    }
    if (strcmp(mode, "hang") == 0) {  // quitting, but the exit path never calls exit(): the grace timer must end it
      [NSNotificationCenter.defaultCenter postNotificationName:UIApplicationWillTerminateNotification object:nil];
      printf("terminating\n");
      for (;;) usleep(10000);
    }
    if (strcmp(mode, "loop") == 0) {  // NeoX-style exit loop: keeps calling exit() until it works
      signal(SIGTERM, SIG_IGN);  // like the stuck game: SIGTERM alone does not end it
      printf("ready\n");
      for (;;) { call_exit(9); usleep(10000); }
    }
    return 2;
  }
  @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(DemoDelegate.class)); }
}
