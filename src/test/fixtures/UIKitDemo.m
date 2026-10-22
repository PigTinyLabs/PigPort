#import <UIKit/UIKit.h>
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
    }
    return 0;
  }
  @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(DemoDelegate.class)); }
}
