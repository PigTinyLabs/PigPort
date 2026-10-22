import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const ANOGS_STUB_SOURCE = `
#import <Foundation/Foundation.h>

@interface PluginTssSDKLifecycle : NSObject
@end

@implementation PluginTssSDKLifecycle
- (instancetype)init { return [super init]; }
- (BOOL)respondsToSelector:(SEL)aSelector { return YES; }
- (id)forwardingTargetForSelector:(SEL)aSelector { return self; }
- (NSMethodSignature *)methodSignatureForSelector:(SEL)aSelector {
    return [NSMethodSignature signatureWithObjCTypes:"v@:"];
}
- (void)forwardInvocation:(NSInvocation *)anInvocation { }
@end

int AnoSDKInit(void *listener, int appId) { return 0; }
int AnoSDKInitEx(void *listener, int appId, const char *token) { return 0; }
void AnoSDKSetUserInfo(int a, const char *b, const char *c) { }
void AnoSDKSetUserInfoWithLicense(int a, const char *b, const char *c, const char *d) { }
void AnoSDKOnPause(void) { }
void AnoSDKOnResume(void) { }
int AnoSDKGetReportData(char **data, int *len) { if (len) *len = 0; return 0; }
int AnoSDKGetReportData2(char **data, int *len) { if (len) *len = 0; return 0; }
int AnoSDKGetReportData3(char **data, int *len) { if (len) *len = 0; return 0; }
int AnoSDKGetReportData4(char **data, int *len) { if (len) *len = 0; return 0; }
void AnoSDKDelReportData(void *data) { }
void AnoSDKDelReportData3(void *data) { }
void AnoSDKDelReportData4(void *data) { }
void AnoSDKFree(void *ptr) { }
int AnoSDKIoctl(int cmd, void *arg) { return 0; }
int AnoSDKIoctlOld(int cmd, void *arg) { return 0; }
void AnoSDKOnRecvData(void *data, int len) { }
void AnoSDKOnRecvSignature(void *sig, int len) { }
int AnoSDKRegistInfoListener(void *listener) { return 0; }
`;

/** Neutralizes Tencent ACE / Tersafe anti-cheat watchdog (anogs) which triggers delayed memory poisoning on Mac Catalyst */
export async function patchAntiCheat(appDir: string): Promise<boolean> {
  const anogsBin = path.join(appDir, 'Frameworks', 'anogs.framework', 'anogs');
  let patched = false;

  const tmpDir = await fs.mkdtemp(path.join(appDir, '..', 'anticheat-stubs-'));
  try {
    if (await fs.stat(anogsBin).then(() => true, () => false)) {
      const src = path.join(tmpDir, 'anogs_stub.m');
      const out = path.join(tmpDir, 'anogs');
      await fs.writeFile(src, ANOGS_STUB_SOURCE, 'utf8');
      await execute('xcrun', [
        '--sdk', 'macosx', 'clang',
        '-target', 'arm64-apple-ios14.0-macabi',
        '-dynamiclib',
        '-install_name', '@rpath/anogs.framework/anogs',
        '-framework', 'Foundation',
        src, '-o', out,
      ]);
      await fs.copyFile(out, anogsBin);
      patched = true;
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return patched;
}
