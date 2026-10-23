// PlayBridge input layer for iOS games running as Mac Catalyst processes.
//
// PlayBridge injects this library with DYLD_INSERT_LIBRARIES when it launches an
// installed IPA. It turns keyboard and mouse input into multi-touch using the same
// keymap format as the Android player (src/shared/keymap.ts) and the same file
// (keymaps/<bundle-id>.json, passed in PLAYBRIDGE_KEYMAP). ⌘K opens an in-game editor.
// It also fits the Mac window to the game's real render size (see PBWindowFit).
//
// Native input mapping and window management implementation.

#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import <Security/Security.h>
#include <dlfcn.h>
#include <errno.h>
#include <mach/mach_time.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <os/lock.h>
#include <stdlib.h>
#include <sys/sysctl.h>
#include <sys/utsname.h>
#include <limits.h>
#include <stdatomic.h>
#include <sys/mount.h>

#ifndef DYLD_INTERPOSE
#define DYLD_INTERPOSE(_replacement, _replacee) \
__attribute__((used)) static struct { const void *replacement; const void *replacee; } _interpose_##_replacee \
__attribute__ ((section ("__DATA,__interpose"))) = { (const void *)(unsigned long)&_replacement, (const void *)(unsigned long)&_replacee };
#endif

#pragma mark - Private UIKit and IOKit touch API

typedef CFTypeRef IOHIDEventRef;
IOHIDEventRef IOHIDEventCreateDigitizerEvent(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t,
                                             double, double, double, double, double, Boolean, Boolean, uint32_t);
IOHIDEventRef IOHIDEventCreateDigitizerFingerEvent(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
                                                   double, double, double, double, double, Boolean, Boolean, uint32_t);
void IOHIDEventAppendEvent(IOHIDEventRef, IOHIDEventRef, uint32_t);
void IOHIDEventSetIntegerValue(IOHIDEventRef, uint32_t, long);
void IOHIDEventSetSenderID(IOHIDEventRef, uint64_t);

enum { kDigitizerRange = 1 << 0, kDigitizerTouch = 1 << 1, kDigitizerPosition = 1 << 2, kDigitizerIdentity = 1 << 5 };
static const uint32_t kDigitizerTransducerHand = 3;
static const uint32_t kFieldDigitizerIsDisplayIntegrated = 0xB0019;

@interface UITouch (PlayBridgePrivate)
- (void)setWindow:(UIWindow *)window;
- (void)setView:(UIView *)view;
- (void)_setLocationInWindow:(CGPoint)point resetPrevious:(BOOL)reset;
- (void)setPhase:(UITouchPhase)phase;
- (void)_setIsFirstTouchForView:(BOOL)first;
- (void)setIsTap:(BOOL)tap;
- (void)setTapCount:(NSUInteger)count;
- (void)setTimestamp:(NSTimeInterval)timestamp;
- (void)_setHidEvent:(IOHIDEventRef)event;
- (void)_setPathIndex:(CFIndex)index;
- (void)_setPathIdentity:(CFIndex)identity;
@end

@interface UIEvent (PlayBridgePrivate)
- (void)_clearTouches;
- (void)_addTouch:(UITouch *)touch forDelayedDelivery:(BOOL)delayed;
- (void)_setHIDEvent:(IOHIDEventRef)event;
@end

@interface UIApplication (PlayBridgePrivate)
- (UIEvent *)_touchesEvent;
@end

#pragma mark - AppKit (loaded in every Catalyst process; the macabi SDK has no headers)

@protocol PBAppKitEvent
- (NSUInteger)type;
- (unsigned short)keyCode;
- (BOOL)isARepeat;
- (NSUInteger)modifierFlags;
- (CGFloat)deltaX;
- (CGFloat)deltaY;
@end

@protocol PBAppKitClasses
- (id)addLocalMonitorForEventsMatchingMask:(unsigned long long)mask handler:(id (^)(id event))handler;
- (void)hide;
- (void)unhide;
- (id)sharedApplication;
- (NSArray *)windows;
@end

@protocol PBAppKitWindow
- (CGRect)frame;
- (BOOL)isVisible;
- (NSUInteger)styleMask;
- (void)setContentAspectRatio:(CGSize)ratio;
- (CGRect)contentRectForFrameRect:(CGRect)frame;
- (CGRect)frameRectForContentRect:(CGRect)content;
- (void)setFrame:(CGRect)frame display:(BOOL)display;
- (BOOL)inLiveResize;
- (CGFloat)backingScaleFactor;
- (id)screen;
- (CGRect)visibleFrame;
@end

static const NSUInteger kFullScreenStyle = 1 << 14;

enum {
  kLeftMouseDown = 1, kLeftMouseUp = 2, kRightMouseDown = 3, kRightMouseUp = 4, kMouseMoved = 5,
  kLeftMouseDragged = 6, kRightMouseDragged = 7, kKeyDown = 10, kKeyUp = 11, kFlagsChanged = 12,
  kOtherMouseDown = 25, kOtherMouseUp = 26, kOtherMouseDragged = 27,
};
static const NSUInteger kCommandFlag = 1 << 20;

#pragma mark - Key names (KeyboardEvent.code, as in the Android player)

static const struct { unsigned short key; const char *code; } kKeys[] = {
  {0x00, "KeyA"}, {0x01, "KeyS"}, {0x02, "KeyD"}, {0x03, "KeyF"}, {0x04, "KeyH"}, {0x05, "KeyG"}, {0x06, "KeyZ"},
  {0x07, "KeyX"}, {0x08, "KeyC"}, {0x09, "KeyV"}, {0x0A, "IntlBackslash"}, {0x0B, "KeyB"}, {0x0C, "KeyQ"},
  {0x0D, "KeyW"}, {0x0E, "KeyE"}, {0x0F, "KeyR"}, {0x10, "KeyY"}, {0x11, "KeyT"}, {0x12, "Digit1"}, {0x13, "Digit2"},
  {0x14, "Digit3"}, {0x15, "Digit4"}, {0x16, "Digit6"}, {0x17, "Digit5"}, {0x18, "Equal"}, {0x19, "Digit9"},
  {0x1A, "Digit7"}, {0x1B, "Minus"}, {0x1C, "Digit8"}, {0x1D, "Digit0"}, {0x1E, "BracketRight"}, {0x1F, "KeyO"},
  {0x20, "KeyU"}, {0x21, "BracketLeft"}, {0x22, "KeyI"}, {0x23, "KeyP"}, {0x24, "Enter"}, {0x25, "KeyL"},
  {0x26, "KeyJ"}, {0x27, "Quote"}, {0x28, "KeyK"}, {0x29, "Semicolon"}, {0x2A, "Backslash"}, {0x2B, "Comma"},
  {0x2C, "Slash"}, {0x2D, "KeyN"}, {0x2E, "KeyM"}, {0x2F, "Period"}, {0x30, "Tab"}, {0x31, "Space"},
  {0x32, "Backquote"}, {0x33, "Backspace"}, {0x35, "Escape"}, {0x36, "MetaRight"}, {0x37, "MetaLeft"},
  {0x38, "ShiftLeft"}, {0x39, "CapsLock"}, {0x3A, "AltLeft"}, {0x3B, "ControlLeft"}, {0x3C, "ShiftRight"},
  {0x3D, "AltRight"}, {0x3E, "ControlRight"}, {0x41, "NumpadDecimal"}, {0x43, "NumpadMultiply"}, {0x45, "NumpadAdd"},
  {0x4B, "NumpadDivide"}, {0x4C, "NumpadEnter"}, {0x4E, "NumpadSubtract"}, {0x51, "NumpadEqual"},
  {0x52, "Numpad0"}, {0x53, "Numpad1"}, {0x54, "Numpad2"}, {0x55, "Numpad3"}, {0x56, "Numpad4"}, {0x57, "Numpad5"},
  {0x58, "Numpad6"}, {0x59, "Numpad7"}, {0x5B, "Numpad8"}, {0x5C, "Numpad9"}, {0x60, "F5"}, {0x61, "F6"},
  {0x62, "F7"}, {0x63, "F3"}, {0x64, "F8"}, {0x65, "F9"}, {0x67, "F11"}, {0x6D, "F10"}, {0x6F, "F12"},
  {0x73, "Home"}, {0x74, "PageUp"}, {0x75, "Delete"}, {0x76, "F4"}, {0x77, "End"}, {0x78, "F2"}, {0x79, "PageDown"},
  {0x7A, "F1"}, {0x7B, "ArrowLeft"}, {0x7C, "ArrowRight"}, {0x7D, "ArrowDown"}, {0x7E, "ArrowUp"},
};

static NSString *PBKeyCode(unsigned short key) {
  for (size_t i = 0; i < sizeof kKeys / sizeof kKeys[0]; i++) if (kKeys[i].key == key) return @(kKeys[i].code);
  return nil;
}

// Device-dependent modifier bits tell left and right modifier keys apart in flagsChanged.
static NSUInteger PBModifierBit(NSString *code) {
  NSDictionary<NSString *, NSNumber *> *bits = @{
    @"ControlLeft": @0x1, @"ShiftLeft": @0x2, @"ShiftRight": @0x4, @"MetaLeft": @0x8, @"MetaRight": @0x10,
    @"AltLeft": @0x20, @"AltRight": @0x40, @"ControlRight": @0x2000, @"CapsLock": @(1 << 16),
  };
  return bits[code].unsignedIntegerValue;
}

static NSString *PBKeyLabel(NSString *code) {
  if (!code.length) return @"?";
  NSDictionary<NSString *, NSString *> *names = @{
    @"ShiftLeft": @"L-Shift", @"ShiftRight": @"R-Shift", @"ControlLeft": @"L-Ctrl", @"ControlRight": @"R-Ctrl",
    @"AltLeft": @"L-Alt", @"AltRight": @"R-Alt", @"MetaLeft": @"L-Cmd", @"MetaRight": @"R-Cmd", @"Backquote": @"`",
    @"ArrowUp": @"↑", @"ArrowDown": @"↓", @"ArrowLeft": @"←", @"ArrowRight": @"→", @"Escape": @"Esc",
    @"CapsLock": @"Caps", @"Minus": @"-", @"Equal": @"=", @"BracketLeft": @"[", @"BracketRight": @"]",
    @"Backslash": @"\\", @"Semicolon": @";", @"Quote": @"'", @"Comma": @",", @"Period": @".", @"Slash": @"/",
    @"MouseLeft": @"LMB", @"MouseRight": @"RMB", @"MouseMiddle": @"MMB",
  };
  if (names[code]) return names[code];
  if ([code hasPrefix:@"Key"]) return [code substringFromIndex:3];
  if ([code hasPrefix:@"Digit"]) return [code substringFromIndex:5];
  if ([code hasPrefix:@"Numpad"]) return [@"Num" stringByAppendingString:[code substringFromIndex:6]];
  return code;
}

static UIWindow *PBGameWindow(void) {
  UIWindow *fallback = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (window.isKeyWindow) return window;
      if (!fallback && !window.hidden) fallback = window;
    }
  }
  return fallback;
}

#pragma mark - Keymap (version 1, normalized coordinates)

static double PBClamp01(id value) {
  double v = [value respondsToSelector:@selector(doubleValue)] ? [value doubleValue] : NAN;
  return isfinite(v) ? fmin(1, fmax(0, v)) : 0.5;
}

static double PBPositive(id value, double fallback) {
  double v = [value respondsToSelector:@selector(doubleValue)] ? [value doubleValue] : NAN;
  return isfinite(v) && v > 0 ? v : fallback;
}

static NSString *PBString(id value, NSString *fallback) {
  return [value isKindOfClass:NSString.class] ? value : fallback;
}

@interface PBKeymap : NSObject <NSCopying>
@property (nonatomic, copy) NSString *lookToggle;
@property (nonatomic, strong) NSMutableArray<NSMutableDictionary *> *elements;
+ (instancetype)loadFrom:(NSString *)path;
- (BOOL)saveTo:(NSString *)path error:(NSError **)error;
- (BOOL)binds:(NSString *)code;
@end

@implementation PBKeymap
+ (instancetype)loadFrom:(NSString *)path {
  PBKeymap *map = [PBKeymap new];
  map.lookToggle = @"Backquote";
  map.elements = [NSMutableArray array];
  NSData *data = path ? [NSData dataWithContentsOfFile:path] : nil;
  NSDictionary *raw = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![raw isKindOfClass:NSDictionary.class] || ![raw[@"version"] isEqual:@1] || ![raw[@"elements"] isKindOfClass:NSArray.class]) return map;
  map.lookToggle = PBString(raw[@"mouseLookToggle"], @"Backquote");
  for (NSDictionary *e in raw[@"elements"]) {
    if (![e isKindOfClass:NSDictionary.class]) continue;
    NSMutableDictionary *clean = [@{ @"type": PBString(e[@"type"], @""), @"x": @(PBClamp01(e[@"x"])), @"y": @(PBClamp01(e[@"y"])) } mutableCopy];
    if ([clean[@"type"] isEqual:@"button"] && [e[@"key"] isKindOfClass:NSString.class]) {
      clean[@"key"] = e[@"key"];
    } else if ([clean[@"type"] isEqual:@"joystick"]) {
      clean[@"up"] = PBString(e[@"up"], @"KeyW"); clean[@"down"] = PBString(e[@"down"], @"KeyS");
      clean[@"left"] = PBString(e[@"left"], @"KeyA"); clean[@"right"] = PBString(e[@"right"], @"KeyD");
      clean[@"radius"] = @(PBPositive(e[@"radius"], 0.1));
    } else if ([clean[@"type"] isEqual:@"camera"]) {
      clean[@"radius"] = @(PBPositive(e[@"radius"], 0.2));
      clean[@"sensitivity"] = @(PBPositive(e[@"sensitivity"], 1));
    } else continue;
    [map.elements addObject:clean];
  }
  return map;
}

- (id)copyWithZone:(NSZone *)zone {
  PBKeymap *copy = [PBKeymap new];
  copy.lookToggle = self.lookToggle;
  copy.elements = [NSMutableArray array];
  for (NSDictionary *e in self.elements) [copy.elements addObject:[e mutableCopy]];
  return copy;
}

- (BOOL)saveTo:(NSString *)path error:(NSError **)error {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"version": @1, @"mouseLookToggle": self.lookToggle, @"elements": self.elements }
                                                 options:NSJSONWritingPrettyPrinted error:error];
  if (!data) return NO;
  if (![NSFileManager.defaultManager createDirectoryAtPath:path.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:error]) return NO;
  return [data writeToFile:path options:NSDataWritingAtomic error:error];
}

- (BOOL)binds:(NSString *)code {
  for (NSDictionary *e in self.elements) {
    if ([e[@"type"] isEqual:@"button"] && [e[@"key"] isEqual:code]) return YES;
    if ([e[@"type"] isEqual:@"joystick"] && ([e[@"up"] isEqual:code] || [e[@"down"] isEqual:code] || [e[@"left"] isEqual:code] || [e[@"right"] isEqual:code])) return YES;
  }
  return NO;
}
@end

#pragma mark - Touch injection

@interface PBTouches : NSObject
- (void)finger:(NSInteger)ident phase:(UITouchPhase)phase at:(CGPoint)point;
- (CGPoint)locationOf:(NSInteger)ident;
- (BOOL)isDown:(NSInteger)ident;
- (void)releaseAll;
@end

@implementation PBTouches {
  NSMutableDictionary<NSNumber *, UITouch *> *_active;
}

- (instancetype)init {
  if ((self = [super init])) _active = [NSMutableDictionary dictionary];
  return self;
}

- (BOOL)isDown:(NSInteger)ident { return _active[@(ident)] != nil; }
- (CGPoint)locationOf:(NSInteger)ident { return [_active[@(ident)] locationInView:nil]; }

- (void)finger:(NSInteger)ident phase:(UITouchPhase)phase at:(CGPoint)point {
  UITouch *touch = _active[@(ident)];
  if (phase == UITouchPhaseBegan) {
    if (touch) [self finger:ident phase:UITouchPhaseEnded at:[touch locationInView:nil]];
    UIWindow *window = PBGameWindow();
    if (!window) return;
    touch = [UITouch new];
    [touch setWindow:window];
    [touch setView:[window hitTest:point withEvent:nil] ?: window];
    [touch setTapCount:1];
    [touch setIsTap:NO];
    [touch _setPathIndex:ident];
    [touch _setPathIdentity:ident + 2];
    [touch _setLocationInWindow:point resetPrevious:YES];
    [touch _setIsFirstTouchForView:YES];
    _active[@(ident)] = touch;
  } else {
    if (!touch) return;
    [touch _setLocationInWindow:point resetPrevious:NO];
  }
  BOOL lifting = phase == UITouchPhaseEnded || phase == UITouchPhaseCancelled;
  NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
  for (UITouch *t in _active.allValues) {
    [t setPhase:t == touch ? phase : UITouchPhaseStationary];
    [t setTimestamp:now];
  }
  // UIKit's gesture environment expects a HID hand event with one finger per touch.
  IOHIDEventRef hand = IOHIDEventCreateDigitizerEvent(kCFAllocatorDefault, mach_absolute_time(), kDigitizerTransducerHand,
                                                      0, 0, kDigitizerTouch, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  IOHIDEventSetIntegerValue(hand, kFieldDigitizerIsDisplayIntegrated, 1);
  for (NSNumber *key in _active) {
    UITouch *t = _active[key];
    BOOL down = !(t == touch && lifting);
    CGPoint p = [t locationInView:nil];
    uint32_t mask = t != touch ? 0 : phase == UITouchPhaseMoved ? kDigitizerPosition : kDigitizerRange | kDigitizerTouch | kDigitizerIdentity;
    IOHIDEventRef finger = IOHIDEventCreateDigitizerFingerEvent(kCFAllocatorDefault, mach_absolute_time(), (uint32_t)key.integerValue,
                                                                (uint32_t)key.integerValue + 2, mask, p.x, p.y, 0, down, 0, down, down, 0);
    IOHIDEventAppendEvent(hand, finger, 0);
    CFRelease(finger);
  }
  IOHIDEventSetSenderID(hand, 0x000000010000027F);
  UIEvent *event = [UIApplication.sharedApplication _touchesEvent];
  [event _clearTouches];
  [event _setHIDEvent:hand];
  for (UITouch *t in _active.allValues) {
    [t _setHidEvent:hand];
    [event _addTouch:t forDelayedDelivery:NO];
  }
  [UIApplication.sharedApplication sendEvent:event];
  CFRelease(hand);
  if (lifting) [_active removeObjectForKey:@(ident)];
}

- (void)releaseAll {
  for (NSNumber *key in _active.allKeys) [self finger:key.integerValue phase:UITouchPhaseEnded at:[self locationOf:key.integerValue]];
}
@end

#pragma mark - Mapper (port of TouchMapper in src/shared/keymap.ts)

@interface PBMapper : NSObject
@property (nonatomic, copy) PBKeymap *map;
- (void)keyDown:(NSString *)code;
- (void)keyUp:(NSString *)code;
- (void)mouseMoveX:(double)dx y:(double)dy;
- (void)tick;
- (void)releaseAll;
@end

@implementation PBMapper {
  PBTouches *_touches;
  NSMutableSet<NSString *> *_pressed;
  NSTimeInterval _cameraLastMove;
}

- (instancetype)init {
  if ((self = [super init])) { _touches = [PBTouches new]; _pressed = [NSMutableSet set]; }
  return self;
}

- (void)setMap:(PBKeymap *)map {
  [self releaseAll];
  _map = [map copy];
}

// Pointer 0 is reserved for direct mouse clicks, as in the Android player.
static NSInteger PBPointer(NSUInteger index) { return (NSInteger)index + 1; }

- (CGSize)size { return PBGameWindow().bounds.size; }

- (void)keyDown:(NSString *)code {
  if ([_pressed containsObject:code]) return;
  [_pressed addObject:code];
  [self update:code];
}

- (void)keyUp:(NSString *)code {
  if (![_pressed containsObject:code]) return;
  [_pressed removeObject:code];
  [self update:code];
}

- (void)update:(NSString *)changed {
  CGSize size = self.size;
  [self.map.elements enumerateObjectsUsingBlock:^(NSMutableDictionary *e, NSUInteger i, BOOL *stop) {
    NSInteger ident = PBPointer(i);
    if ([e[@"type"] isEqual:@"button"] && [e[@"key"] isEqual:changed]) {
      CGPoint p = CGPointMake([e[@"x"] doubleValue] * size.width, [e[@"y"] doubleValue] * size.height);
      if ([self->_pressed containsObject:changed]) [self->_touches finger:ident phase:UITouchPhaseBegan at:p];
      else if ([self->_touches isDown:ident]) [self->_touches finger:ident phase:UITouchPhaseEnded at:p];
    } else if ([e[@"type"] isEqual:@"joystick"] && [@[e[@"up"], e[@"down"], e[@"left"], e[@"right"]] containsObject:changed]) {
      [self updateJoystick:e pointer:ident size:size];
    }
  }];
}

- (void)updateJoystick:(NSDictionary *)e pointer:(NSInteger)ident size:(CGSize)size {
  double dx = ([_pressed containsObject:e[@"right"]] ? 1 : 0) - ([_pressed containsObject:e[@"left"]] ? 1 : 0);
  double dy = ([_pressed containsObject:e[@"down"]] ? 1 : 0) - ([_pressed containsObject:e[@"up"]] ? 1 : 0);
  CGPoint centre = CGPointMake([e[@"x"] doubleValue] * size.width, [e[@"y"] doubleValue] * size.height);
  if (dx == 0 && dy == 0) {
    if ([_touches isDown:ident]) [_touches finger:ident phase:UITouchPhaseEnded at:[_touches locationOf:ident]];
    return;
  }
  double len = hypot(dx, dy), r = [e[@"radius"] doubleValue] * size.height;
  if (![_touches isDown:ident]) [_touches finger:ident phase:UITouchPhaseBegan at:centre];
  [_touches finger:ident phase:UITouchPhaseMoved at:CGPointMake(centre.x + dx / len * r, centre.y + dy / len * r)];
}

- (void)mouseMoveX:(double)dx y:(double)dy {
  CGSize size = self.size;
  [self.map.elements enumerateObjectsUsingBlock:^(NSMutableDictionary *e, NSUInteger i, BOOL *stop) {
    if (![e[@"type"] isEqual:@"camera"]) return;
    NSInteger ident = PBPointer(i);
    CGPoint centre = CGPointMake([e[@"x"] doubleValue] * size.width, [e[@"y"] doubleValue] * size.height);
    if (![self->_touches isDown:ident]) [self->_touches finger:ident phase:UITouchPhaseBegan at:centre];
    CGPoint cur = [self->_touches locationOf:ident];
    double s = [e[@"sensitivity"] doubleValue];
    cur.x += dx * s; cur.y += dy * s;
    if (hypot(cur.x - centre.x, cur.y - centre.y) > [e[@"radius"] doubleValue] * size.height) {
      // Out of drag room: lift and start a fresh drag from the centre.
      [self->_touches finger:ident phase:UITouchPhaseEnded at:cur];
      [self->_touches finger:ident phase:UITouchPhaseBegan at:centre];
    } else {
      [self->_touches finger:ident phase:UITouchPhaseMoved at:cur];
    }
    self->_cameraLastMove = NSProcessInfo.processInfo.systemUptime;
  }];
}

// Lift the camera finger once the mouse has been still for a moment.
- (void)tick {
  if (NSProcessInfo.processInfo.systemUptime - _cameraLastMove < 0.12) return;
  [self.map.elements enumerateObjectsUsingBlock:^(NSMutableDictionary *e, NSUInteger i, BOOL *stop) {
    NSInteger ident = PBPointer(i);
    if ([e[@"type"] isEqual:@"camera"] && [self->_touches isDown:ident]) [self->_touches finger:ident phase:UITouchPhaseEnded at:[self->_touches locationOf:ident]];
  }];
}

- (void)releaseAll {
  [_touches releaseAll];
  [_pressed removeAllObjects];
}
@end

#pragma mark - In-game editor

static UIColor *PBAccent(void) { return [UIColor colorWithRed:1 green:0.8 blue:0.2 alpha:1]; }

@interface PBEditor : UIView
@property (nonatomic, copy) void (^onClose)(PBKeymap *saved);
- (instancetype)initWithKeymap:(PBKeymap *)map canSave:(BOOL)canSave;
/// Receives every key press while the editor is open.
- (void)keyDown:(NSString *)code command:(BOOL)command;
- (void)mouseButton:(NSString *)code;
@end

@implementation PBEditor {
  PBKeymap *_map;
  BOOL _canSave, _waitingForLookKey;
  CGFloat _builtHeight;
  NSInteger _selected;
  NSString *_slot;
  UIStackView *_toolbar;
  UILabel *_hint;
  UIButton *_lookButton, *_sizeUp, *_sizeDown, *_sensUp, *_sensDown, *_leftClick, *_delete;
  NSMutableArray<UIView *> *_controls;
}

- (instancetype)initWithKeymap:(PBKeymap *)map canSave:(BOOL)canSave {
  if (!(self = [super initWithFrame:CGRectZero])) return nil;
  _map = [map copy];
  _canSave = canSave;
  _selected = -1;
  _controls = [NSMutableArray array];
  self.backgroundColor = [UIColor colorWithWhite:0 alpha:0.35];
  self.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  UITapGestureRecognizer *background = [[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(deselect)];
  [self addGestureRecognizer:background];

  _toolbar = [UIStackView new];
  _toolbar.axis = UILayoutConstraintAxisHorizontal;
  _toolbar.spacing = 6;
  _toolbar.translatesAutoresizingMaskIntoConstraints = NO;
  [self addSubview:_toolbar];
  [self button:@"+ Button" action:@selector(addButton)];
  [self button:@"+ Joystick" action:@selector(addJoystick)];
  [self button:@"+ Mouse look" action:@selector(addCamera)];
  _sizeDown = [self button:@"Smaller" action:@selector(smaller)];
  _sizeUp = [self button:@"Bigger" action:@selector(bigger)];
  _sensDown = [self button:@"Sens −" action:@selector(slower)];
  _sensUp = [self button:@"Sens +" action:@selector(faster)];
  _leftClick = [self button:@"Left click" action:@selector(assignLeftClick)];
  _delete = [self button:@"Delete" action:@selector(deleteSelected)];
  _lookButton = [self button:@"" action:@selector(chooseLookKey)];
  [self button:canSave ? @"Save" : @"Apply" action:@selector(save)];
  [self button:@"Cancel" action:@selector(cancel)];

  _hint = [UILabel new];
  _hint.textColor = UIColor.whiteColor;
  _hint.font = [UIFont systemFontOfSize:13 weight:UIFontWeightMedium];
  _hint.textAlignment = NSTextAlignmentCenter;
  _hint.numberOfLines = 2;
  _hint.translatesAutoresizingMaskIntoConstraints = NO;
  [self addSubview:_hint];
  [NSLayoutConstraint activateConstraints:@[
    [_toolbar.topAnchor constraintEqualToAnchor:self.safeAreaLayoutGuide.topAnchor constant:12],
    [_toolbar.centerXAnchor constraintEqualToAnchor:self.centerXAnchor],
    [_hint.topAnchor constraintEqualToAnchor:_toolbar.bottomAnchor constant:8],
    [_hint.centerXAnchor constraintEqualToAnchor:self.centerXAnchor],
    [_hint.widthAnchor constraintLessThanOrEqualToAnchor:self.widthAnchor constant:-40],
  ]];
  [self rebuild];
  return self;
}

- (UIButton *)button:(NSString *)title action:(SEL)action {
  UIButton *b = [UIButton buttonWithType:UIButtonTypeSystem];
  [b setTitle:title forState:UIControlStateNormal];
  [b setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
  [b setTitleColor:[UIColor colorWithWhite:1 alpha:0.35] forState:UIControlStateDisabled];
  b.titleLabel.font = [UIFont systemFontOfSize:13 weight:UIFontWeightSemibold];
  b.backgroundColor = [UIColor colorWithWhite:0.12 alpha:0.9];
  b.layer.cornerRadius = 7;
  b.contentEdgeInsets = UIEdgeInsetsMake(6, 10, 6, 10);
  [b addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
  [_toolbar addArrangedSubview:b];
  return b;
}

- (NSMutableDictionary *)selectedElement {
  return _selected >= 0 && _selected < (NSInteger)_map.elements.count ? _map.elements[_selected] : nil;
}

- (void)rebuild {
  for (UIView *v in _controls) [v removeFromSuperview];
  [_controls removeAllObjects];
  [_map.elements enumerateObjectsUsingBlock:^(NSMutableDictionary *e, NSUInteger i, BOOL *stop) {
    UIView *v = [self controlFor:e index:i];
    [self insertSubview:v belowSubview:self->_toolbar];
    [self->_controls addObject:v];
  }];
  [self setNeedsLayout];
  [self refreshChrome];
}

- (UILabel *)badge:(NSString *)text size:(CGFloat)size selected:(BOOL)selected {
  UILabel *l = [[UILabel alloc] initWithFrame:CGRectMake(0, 0, size, size)];
  l.text = text;
  l.textAlignment = NSTextAlignmentCenter;
  l.font = [UIFont systemFontOfSize:size > 40 ? 15 : 12 weight:UIFontWeightBold];
  l.adjustsFontSizeToFitWidth = YES;
  l.textColor = selected ? UIColor.blackColor : UIColor.whiteColor;
  l.backgroundColor = selected ? PBAccent() : [UIColor colorWithWhite:0.1 alpha:0.75];
  l.layer.cornerRadius = size / 2;
  l.layer.borderWidth = 2;
  l.layer.borderColor = (selected ? PBAccent() : UIColor.whiteColor).CGColor;
  l.clipsToBounds = YES;
  return l;
}

- (UIView *)controlFor:(NSMutableDictionary *)e index:(NSUInteger)index {
  BOOL selected = (NSInteger)index == _selected;
  CGFloat height = MAX(self.bounds.size.height, 1);
  UIView *view;
  if ([e[@"type"] isEqual:@"button"]) {
    view = [self badge:PBKeyLabel(e[@"key"]) size:48 selected:selected];
  } else {
    CGFloat d = 2 * [e[@"radius"] doubleValue] * height;
    view = [[UIView alloc] initWithFrame:CGRectMake(0, 0, d, d)];
    view.layer.cornerRadius = d / 2;
    view.layer.borderWidth = 2;
    view.layer.borderColor = (selected ? PBAccent() : UIColor.whiteColor).CGColor;
    view.backgroundColor = [UIColor colorWithWhite:1 alpha:0.12];
    if ([e[@"type"] isEqual:@"joystick"]) {
      NSArray *slots = @[@[@"up", @0.5, @0.0], @[@"down", @0.5, @1.0], @[@"left", @0.0, @0.5], @[@"right", @1.0, @0.5]];
      for (NSArray *slot in slots) {
        UILabel *pad = [self badge:PBKeyLabel(e[slot[0]]) size:34 selected:selected && [_slot isEqual:slot[0]]];
        pad.center = CGPointMake([slot[1] doubleValue] * d, [slot[2] doubleValue] * d);
        pad.userInteractionEnabled = YES;
        pad.accessibilityIdentifier = slot[0];
        [pad addGestureRecognizer:[[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(tapPad:)]];
        [view addSubview:pad];
      }
    } else {
      UILabel *title = [UILabel new];
      title.text = [NSString stringWithFormat:@"Mouse look\n×%.2g", [e[@"sensitivity"] doubleValue]];
      title.numberOfLines = 2;
      title.textAlignment = NSTextAlignmentCenter;
      title.textColor = UIColor.whiteColor;
      title.font = [UIFont systemFontOfSize:13 weight:UIFontWeightBold];
      [title sizeToFit];
      title.center = CGPointMake(d / 2, d / 2);
      [view addSubview:title];
    }
  }
  view.tag = (NSInteger)index;
  view.userInteractionEnabled = YES;
  [view addGestureRecognizer:[[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(tapControl:)]];
  [view addGestureRecognizer:[[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(drag:)]];
  return view;
}

- (void)layoutSubviews {
  [super layoutSubviews];
  CGSize size = self.bounds.size;
  // Joystick and mouse-look circles are sized from the height.
  if (size.height != _builtHeight) {
    _builtHeight = size.height;
    [self rebuild];
  }
  for (UIView *v in _controls) {
    NSDictionary *e = _map.elements[v.tag];
    v.center = CGPointMake([e[@"x"] doubleValue] * size.width, [e[@"y"] doubleValue] * size.height);
  }
}

- (void)refreshChrome {
  NSDictionary *e = self.selectedElement;
  NSString *type = e[@"type"];
  BOOL round = [type isEqual:@"joystick"] || [type isEqual:@"camera"];
  _sizeUp.enabled = _sizeDown.enabled = round;
  _sensUp.enabled = _sensDown.enabled = [type isEqual:@"camera"];
  _leftClick.enabled = [type isEqual:@"button"];
  _delete.enabled = e != nil;
  [_lookButton setTitle:_waitingForLookKey ? @"Look key: …" : [@"Look key: " stringByAppendingString:PBKeyLabel(_map.lookToggle)] forState:UIControlStateNormal];
  if (_waitingForLookKey) _hint.text = @"Press the key that turns mouse look on and off.";
  else if ([type isEqual:@"button"]) _hint.text = @"Press a key for this button, or right/middle click. Drag to move.";
  else if ([type isEqual:@"joystick"]) _hint.text = _slot ? [NSString stringWithFormat:@"Press a key for %@.", _slot] : @"Click a direction to change its key. Drag to move; Bigger/Smaller change travel.";
  else if ([type isEqual:@"camera"]) _hint.text = @"Mouse look drags from here. Bigger/Smaller change drag room, Sens ± change speed.";
  else _hint.text = [NSString stringWithFormat:@"Drag controls onto the game, click one to change it. ⌘K %@ · Esc cancel.", _canSave ? @"save" : @"apply"];
}

- (void)select:(NSInteger)index slot:(NSString *)slot {
  _selected = index;
  _slot = slot;
  _waitingForLookKey = NO;
  [self rebuild];
}

- (void)deselect { [self select:-1 slot:nil]; }
- (void)tapControl:(UITapGestureRecognizer *)g { [self select:g.view.tag slot:nil]; }
- (void)tapPad:(UITapGestureRecognizer *)g { [self select:g.view.superview.tag slot:g.view.accessibilityIdentifier]; }

- (void)drag:(UIPanGestureRecognizer *)g {
  NSMutableDictionary *e = _map.elements[g.view.tag];
  CGPoint p = [g locationInView:self];
  e[@"x"] = @(PBClamp01(@(p.x / MAX(self.bounds.size.width, 1))));
  e[@"y"] = @(PBClamp01(@(p.y / MAX(self.bounds.size.height, 1))));
  if (g.state == UIGestureRecognizerStateBegan && _selected != g.view.tag) [self select:g.view.tag slot:nil];
  else [self setNeedsLayout];
}

- (void)add:(NSMutableDictionary *)element {
  [_map.elements addObject:element];
  [self select:(NSInteger)_map.elements.count - 1 slot:nil];
}

- (void)addButton { [self add:[@{ @"type": @"button", @"key": @"", @"x": @0.5, @"y": @0.5 } mutableCopy]]; }
- (void)addJoystick {
  [self add:[@{ @"type": @"joystick", @"x": @0.2, @"y": @0.7, @"radius": @0.12, @"up": @"KeyW", @"down": @"KeyS", @"left": @"KeyA", @"right": @"KeyD" } mutableCopy]];
}
- (void)addCamera { [self add:[@{ @"type": @"camera", @"x": @0.7, @"y": @0.45, @"radius": @0.2, @"sensitivity": @1 } mutableCopy]]; }

- (void)scale:(NSString *)field by:(double)factor min:(double)min max:(double)max {
  NSMutableDictionary *e = self.selectedElement;
  if (!e[field]) return;
  e[field] = @(fmin(max, fmax(min, [e[field] doubleValue] * factor)));
  [self rebuild];
}

- (void)bigger { [self scale:@"radius" by:1.15 min:0.03 max:0.5]; }
- (void)smaller { [self scale:@"radius" by:1 / 1.15 min:0.03 max:0.5]; }
- (void)faster { [self scale:@"sensitivity" by:1.25 min:0.1 max:10]; }
- (void)slower { [self scale:@"sensitivity" by:0.8 min:0.1 max:10]; }

- (void)assign:(NSString *)code {
  NSMutableDictionary *e = self.selectedElement;
  if ([e[@"type"] isEqual:@"button"]) e[@"key"] = code;
  else if ([e[@"type"] isEqual:@"joystick"] && _slot) e[_slot] = code;
  else return;
  [self rebuild];
}

- (void)assignLeftClick { [self assign:@"MouseLeft"]; }

- (void)deleteSelected {
  if (!self.selectedElement) return;
  [_map.elements removeObjectAtIndex:_selected];
  [self deselect];
}

- (void)chooseLookKey {
  _waitingForLookKey = YES;
  [self refreshChrome];
}

- (void)keyDown:(NSString *)code command:(BOOL)command {
  if (command) {
    if ([code isEqual:@"KeyK"] || [code isEqual:@"KeyS"]) [self save];
    return;
  }
  if (_waitingForLookKey) {
    if (![code isEqual:@"Escape"]) _map.lookToggle = code;
    _waitingForLookKey = NO;
    [self refreshChrome];
  } else if ([code isEqual:@"Escape"]) {
    if (self.selectedElement) [self deselect];
    else [self cancel];
  } else {
    [self assign:code];
  }
}

- (void)mouseButton:(NSString *)code { [self assign:code]; }

- (void)save {
  if (self.onClose) self.onClose(_map);
}

- (void)cancel {
  if (self.onClose) self.onClose(nil);
}
@end

#pragma mark - Controller

static BOOL PBTextInputActive(void);

@interface PBInput : NSObject
@end

static NSString *gKeymapPath;

@implementation PBInput {
  PBMapper *_mapper;
  PBEditor *_editor;
  BOOL _mouseLook;
  NSUInteger _modifiers;
  NSTimer *_timer;
  id<PBAppKitClasses> _cursor;
  int (*_associateMouse)(int);
}

+ (instancetype)shared {
  static PBInput *input;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ input = [PBInput new]; });
  return input;
}

- (void)start {
  id<PBAppKitClasses> events = (id)objc_getClass("NSEvent");
  _cursor = (id)objc_getClass("NSCursor");
  _associateMouse = (int (*)(int))dlsym(RTLD_DEFAULT, "CGAssociateMouseAndMouseCursorPosition");
  if (!events) { NSLog(@"PigPort input: AppKit is unavailable; controls are disabled."); return; }
  _mapper = [PBMapper new];
  _mapper.map = [PBKeymap loadFrom:gKeymapPath];
  const int types[] = { kLeftMouseDown, kLeftMouseUp, kRightMouseDown, kRightMouseUp, kMouseMoved, kLeftMouseDragged,
                        kRightMouseDragged, kKeyDown, kKeyUp, kFlagsChanged, kOtherMouseDown, kOtherMouseUp, kOtherMouseDragged };
  unsigned long long mask = 0;
  for (size_t i = 0; i < sizeof types / sizeof types[0]; i++) mask |= 1ULL << types[i];
  __weak PBInput *weakSelf = self;
  [events addLocalMonitorForEventsMatchingMask:mask handler:^id(id event) {
    PBInput *input = weakSelf;
    return input ? [input handle:event] : event;
  }];
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserver:self selector:@selector(resignActive) name:UIApplicationWillResignActiveNotification object:nil];
  [center addObserver:self selector:@selector(becomeActive) name:UIApplicationDidBecomeActiveNotification object:nil];
  [self toast:[NSString stringWithFormat:@"PigPort controls: ⌘K edit · %@ mouse look", PBKeyLabel(_mapper.map.lookToggle)]];
}

- (void)becomeActive {
  // Pick up keymaps imported or edited in PlayBridge while the game was in the background.
  if (!_editor) _mapper.map = [PBKeymap loadFrom:gKeymapPath];
}

- (void)resignActive {
  [self setMouseLook:NO];
  [_mapper releaseAll];
}

- (id)handle:(id<PBAppKitEvent>)event {
  NSUInteger type = event.type;
  if (type == kKeyDown || type == kKeyUp) return [self key:event down:type == kKeyDown];
  if (type == kFlagsChanged) return [self modifiers:event];
  NSString *button = type == kLeftMouseDown || type == kLeftMouseUp ? @"MouseLeft"
                   : type == kRightMouseDown || type == kRightMouseUp ? @"MouseRight"
                   : type == kOtherMouseDown || type == kOtherMouseUp ? @"MouseMiddle" : nil;
  BOOL down = type == kLeftMouseDown || type == kRightMouseDown || type == kOtherMouseDown;
  if (_editor) {
    // Left clicks drive the editor UI; other buttons can be assigned to a control.
    if (button && ![button isEqual:@"MouseLeft"]) { if (down) [_editor mouseButton:button]; return nil; }
    return event;
  }
  if (!_mouseLook) return event; // Outside mouse look, clicks are direct touches.
  if (button) {
    if (down) [_mapper keyDown:button];
    else [_mapper keyUp:button];
  } else {
    [_mapper mouseMoveX:event.deltaX y:event.deltaY];
  }
  return nil;
}

- (id)key:(id<PBAppKitEvent>)event down:(BOOL)down {
  NSString *code = PBKeyCode(event.keyCode);
  BOOL command = (event.modifierFlags & kCommandFlag) != 0;
  if (!code) return event;
  if (_editor) {
    if (down) [_editor keyDown:code command:command];
    return nil;
  }
  if (down && command && [code isEqual:@"KeyK"]) { [self openEditor]; return nil; }
  if (command || PBTextInputActive()) return event;
  if ([code isEqual:_mapper.map.lookToggle]) {
    if (down && !event.isARepeat) [self setMouseLook:!_mouseLook];
    return nil;
  }
  if (_mouseLook && [code isEqual:@"Escape"]) {
    if (down) [self setMouseLook:NO];
    return nil;
  }
  if (![_mapper.map binds:code]) return event;
  if (down) [_mapper keyDown:code];
  else [_mapper keyUp:code];
  return nil;
}

- (id)modifiers:(id<PBAppKitEvent>)event {
  NSUInteger flags = event.modifierFlags, changed = flags ^ _modifiers;
  _modifiers = flags;
  NSString *code = PBKeyCode(event.keyCode);
  NSUInteger bit = PBModifierBit(code);
  if (_editor || !bit || !(changed & bit) || ![_mapper.map binds:code] || PBTextInputActive()) return event;
  if (flags & bit) [_mapper keyDown:code];
  else [_mapper keyUp:code];
  return event;
}

- (void)setMouseLook:(BOOL)on {
  if (on == _mouseLook) return;
  _mouseLook = on;
  if (on) {
    [_cursor hide];
    if (_associateMouse) _associateMouse(0);
    _timer = [NSTimer timerWithTimeInterval:0.05 repeats:YES block:^(NSTimer *t) { [self->_mapper tick]; }];
    [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
    [self toast:[NSString stringWithFormat:@"Mouse look on · %@ or Esc to exit", PBKeyLabel(_mapper.map.lookToggle)]];
  } else {
    [_timer invalidate];
    _timer = nil;
    if (_associateMouse) _associateMouse(1);
    [_cursor unhide];
    [_mapper releaseAll];
  }
}

- (void)openEditor {
  UIWindow *window = PBGameWindow();
  if (!window || _editor) return;
  [self setMouseLook:NO];
  [_mapper releaseAll];
  _editor = [[PBEditor alloc] initWithKeymap:_mapper.map canSave:gKeymapPath != nil];
  _editor.frame = window.bounds;
  __weak PBInput *weakSelf = self;
  _editor.onClose = ^(PBKeymap *saved) { [weakSelf closeEditor:saved]; };
  [window addSubview:_editor];
}

- (void)closeEditor:(PBKeymap *)saved {
  [_editor removeFromSuperview];
  _editor = nil;
  if (!saved) return;
  _mapper.map = saved;
  NSError *error;
  if (gKeymapPath && ![saved saveTo:gKeymapPath error:&error]) [self toast:[@"Could not save controls: " stringByAppendingString:error.localizedDescription]];
  else [self toast:gKeymapPath ? @"Controls saved" : @"Controls applied for this session"];
}

- (void)toast:(NSString *)text {
  UIWindow *window = PBGameWindow();
  if (!window) return;
  UILabel *label = [UILabel new];
  label.text = [NSString stringWithFormat:@"  %@  ", text];
  label.font = [UIFont systemFontOfSize:13 weight:UIFontWeightSemibold];
  label.textColor = UIColor.whiteColor;
  label.backgroundColor = [UIColor colorWithWhite:0 alpha:0.7];
  label.layer.cornerRadius = 8;
  label.clipsToBounds = YES;
  label.userInteractionEnabled = NO;
  [label sizeToFit];
  label.frame = CGRectInset(label.frame, 0, -6);
  // Bottom edge: clear of the editor toolbar and of most games' top bars.
  label.center = CGPointMake(window.bounds.size.width / 2, window.bounds.size.height - window.safeAreaInsets.bottom - 36);
  label.autoresizingMask = UIViewAutoresizingFlexibleLeftMargin | UIViewAutoresizingFlexibleRightMargin | UIViewAutoresizingFlexibleTopMargin;
  [window addSubview:label];
  [UIView animateWithDuration:0.4 delay:3.5 options:0 animations:^{ label.alpha = 0; } completion:^(BOOL done) { [label removeFromSuperview]; }];
}
@end

#pragma mark - Supported orientation

// From Info.plist: >0 landscape only, <0 portrait only, 0 either.
static int PBSupportedOrientation(void) {
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  NSArray *list = info[@"UISupportedInterfaceOrientations~ipad"] ?: info[@"UISupportedInterfaceOrientations"];
  BOOL landscape = NO, portrait = NO;
  for (NSString *o in [list isKindOfClass:NSArray.class] ? list : @[]) {
    if (![o isKindOfClass:NSString.class]) continue;
    landscape |= [o containsString:@"Landscape"];
    portrait |= [o containsString:@"Portrait"];
  }
  return landscape == portrait ? 0 : landscape ? 1 : -1;
}

#pragma mark - Rotation

// On an iPad, iOS rotates a landscape-only game to landscape right after launch and tells
// the root view controller; engines (older Unity) only learn the orientation from that event.
// A Mac window never rotates, so such a game keeps rendering a portrait frame. Send it the
// rotation an iPad would.
@interface PBRotationCoordinator : NSObject <UIViewControllerTransitionCoordinator>
@end

@implementation PBRotationCoordinator
- (BOOL)isAnimated { return NO; }
- (UIModalPresentationStyle)presentationStyle { return UIModalPresentationFullScreen; }
- (BOOL)initiallyInteractive { return NO; }
- (BOOL)isInterruptible { return NO; }
- (BOOL)isInteractive { return NO; }
- (BOOL)isCancelled { return NO; }
- (NSTimeInterval)transitionDuration { return 0; }
- (CGFloat)percentComplete { return 1; }
- (CGFloat)completionVelocity { return 1; }
- (UIViewAnimationCurve)completionCurve { return UIViewAnimationCurveLinear; }
- (UIViewController *)viewControllerForKey:(UITransitionContextViewControllerKey)key { return PBGameWindow().rootViewController; }
- (UIView *)viewForKey:(UITransitionContextViewKey)key { return PBGameWindow().rootViewController.view; }
- (UIView *)containerView { return PBGameWindow(); }
- (CGAffineTransform)targetTransform { return CGAffineTransformMakeRotation(-M_PI_2); }
- (BOOL)animateAlongsideTransition:(void (^)(id<UIViewControllerTransitionCoordinatorContext>))animation completion:(void (^)(id<UIViewControllerTransitionCoordinatorContext>))completion {
  if (animation) animation(self);
  if (completion) dispatch_async(dispatch_get_main_queue(), ^{ completion(self); });
  return YES;
}
- (BOOL)animateAlongsideTransitionInView:(UIView *)view animation:(void (^)(id<UIViewControllerTransitionCoordinatorContext>))animation completion:(void (^)(id<UIViewControllerTransitionCoordinatorContext>))completion {
  return [self animateAlongsideTransition:animation completion:completion];
}
- (void)notifyWhenInteractionEndsUsingBlock:(void (^)(id<UIViewControllerTransitionCoordinatorContext>))handler {}
- (void)notifyWhenInteractionChangesUsingBlock:(void (^)(id<UIViewControllerTransitionCoordinatorContext>))handler {}
@end

static int gRotationsSent;

static BOOL PBOverrides(UIViewController *controller, SEL sel) {
  return class_getMethodImplementation(controller.class, sel) != class_getMethodImplementation(UIViewController.class, sel);
}

static void PBSendLandscapeRotation(UIViewController *controller) {
  gRotationsSent++;
  SEL transition = @selector(viewWillTransitionToSize:withTransitionCoordinator:);
  if (PBOverrides(controller, transition)) {
    [controller viewWillTransitionToSize:controller.view.bounds.size withTransitionCoordinator:[PBRotationCoordinator new]];
    return;
  }
  // Pre-iOS 8 rotation callbacks, still used by older engines.
  SEL will = NSSelectorFromString(@"willRotateToInterfaceOrientation:duration:"), did = NSSelectorFromString(@"didRotateFromInterfaceOrientation:");
  if (PBOverrides(controller, will)) ((void (*)(id, SEL, NSInteger, NSTimeInterval))objc_msgSend)(controller, will, UIInterfaceOrientationLandscapeRight, 0);
  if (PBOverrides(controller, did)) ((void (*)(id, SEL, NSInteger))objc_msgSend)(controller, did, UIInterfaceOrientationPortrait);
}

#pragma mark - Window fit


// A Catalyst window can have any shape, but iOS games are made for a device screen. Some render
// at a fixed size whatever the window (stretched when the shapes differ); others follow the
// view (Unity), so any shape "works" but the layout was designed for the device's aspect.
// Measure the game's real render target (its Metal drawable): a fixed-size target sets the
// window's aspect ratio; otherwise the window takes the screen's aspect, turned to the
// orientation the game supports. The game's windows always fill the scene. A report of the
static BOOL PBIsIPhone(void);
static const char *PBDeviceMachineIdentifier(void);
static NSString *PBDeviceModelName(void);

@interface PBWindowFit : NSObject
+ (void)start;
@end

@implementation PBWindowFit

static NSString *gDisplayReport;
static BOOL gFitScheduled;
// Consecutive window resizes that did not reach the target shape. Some windows round or
// clamp the size we ask for; give up instead of resizing forever.
static int gSnapAttempts;

+ (void)start {
  for (NSString *name in @[@"NSWindowDidResizeNotification", @"NSWindowDidEndLiveResizeNotification", @"NSWindowDidExitFullScreenNotification",
                           @"NSWindowDidEnterFullScreenNotification", @"NSWindowDidChangeScreenNotification"]) {
    [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
      if (![name isEqual:@"NSWindowDidResizeNotification"]) gSnapAttempts = 0;
      [self scheduleFit];
    }];
  }
  // Games start rendering, and may change resolution, well after launch.
  [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *t) { [self scheduleFit]; }];
  [self scheduleFit];
}

// Never fit from inside a resize: our own resize posts the notification again.
+ (void)scheduleFit {
  if (gFitScheduled) return;
  gFitScheduled = YES;
  dispatch_async(dispatch_get_main_queue(), ^{
    gFitScheduled = NO;
    [self fit];
  });
}

// The game's render target: the largest Metal layer backing a view in its windows.
+ (CAMetalLayer *)renderLayer {
  CAMetalLayer *best = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    NSMutableArray<UIView *> *queue = [((UIWindowScene *)scene).windows mutableCopy];
    while (queue.count) {
      UIView *view = queue.lastObject;
      [queue removeLastObject];
      if (view.hidden) continue;
      CALayer *layer = view.layer;
      if ([layer isKindOfClass:CAMetalLayer.class] && layer.bounds.size.width * layer.bounds.size.height > best.bounds.size.width * best.bounds.size.height) best = (CAMetalLayer *)layer;
      [queue addObjectsFromArray:view.subviews];
    }
  }
  return best;
}

+ (void)fit {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    CGRect bounds = ((UIWindowScene *)scene).coordinateSpace.bounds;
    for (UIWindow *w in ((UIWindowScene *)scene).windows) if (!w.hidden && !CGRectEqualToRect(w.frame, bounds)) w.frame = bounds;
  }
  CAMetalLayer *layer = [self renderLayer];
  CGSize drawn = layer.drawableSize, shown = layer.bounds.size;
  UIViewController *root = PBGameWindow().rootViewController;
  if (root && gRotationsSent < 3 && PBSupportedOrientation() > 0 && drawn.width > 0 && drawn.width < drawn.height && shown.width > shown.height) PBSendLandscapeRotation(root);
  CGSize target = [self targetFor:layer];
  if (target.width <= 0 || target.height <= 0) return;
  id<PBAppKitClasses> app = [(id<PBAppKitClasses>)(id)objc_getClass("NSApplication") sharedApplication];
  for (id<PBAppKitWindow> window in app.windows) {
    if (![NSStringFromClass([(id)window class]) isEqual:@"UINSWindow"] || !window.isVisible) continue;
    [window setContentAspectRatio:target];
    CGRect content = [window contentRectForFrameRect:window.frame];
    [self report:window content:content layer:layer];
    if ((window.styleMask & kFullScreenStyle) || window.inLiveResize) continue;
    double want = target.width / target.height, have = content.size.width / content.size.height;
    if (fabs(want / have - 1) < 0.005) { gSnapAttempts = 0; continue; }
    if (gSnapAttempts >= 3) continue;
    gSnapAttempts++;
    // Keep the area and top edge, within the screen's visible area.
    CGSize room = [window contentRectForFrameRect:[window.screen visibleFrame]].size;
    CGFloat area = content.size.width * content.size.height;
    CGSize size = CGSizeMake(round(sqrt(area * want)), round(sqrt(area / want)));
    if (room.width > 0 && room.height > 0 && (size.width > room.width || size.height > room.height)) {
      CGFloat shrink = fmin(room.width / size.width, room.height / size.height);
      size = CGSizeMake(floor(size.width * shrink), floor(size.height * shrink));
    }
    CGRect next = CGRectMake(content.origin.x, CGRectGetMaxY(content) - size.height, size.width, size.height);
    [window setFrame:[window frameRectForContentRect:next] display:YES];
  }
}

+ (CGSize)targetFor:(CAMetalLayer *)layer {
  int orientation = PBSupportedOrientation();
  CGSize screen = UIScreen.mainScreen.bounds.size;
  if ((orientation > 0) != (screen.width >= screen.height) && orientation != 0) screen = CGSizeMake(screen.height, screen.width);
  CGSize drawable = layer.drawableSize, view = layer.bounds.size;
  if (drawable.width <= 0 || drawable.height <= 0 || view.width <= 0 || view.height <= 0) return screen;
  double drawn = drawable.width / drawable.height;
  // A target that follows the view adapts to any window; use the device shape.
  if (fabs(drawn / (view.width / view.height) - 1) < 0.02) return screen;
  // Fixed-size target, unless it is a transient frame in an orientation the game does not use.
  if ((orientation > 0 && drawn < 1) || (orientation < 0 && drawn > 1)) return screen;
  return drawable;
}

+ (void)report:(id<PBAppKitWindow>)window content:(CGRect)content layer:(CAMetalLayer *)layer {
  UIScreen *screen = UIScreen.mainScreen;
  CGFloat backing = [window backingScaleFactor];
  // Below 1, the game's frames are upscaled to the window and look soft.
  double sharpness = layer ? layer.drawableSize.width / (content.size.width * backing) : 0;
  NSString *text = [NSString stringWithFormat:
    @"window content (Mac points): %.0f x %.0f, backing scale %.0f\nwindow pixels: %.0f x %.0f\n"
    @"UIScreen: %.0f x %.0f points, scale %.1f, native %.0f x %.0f\nscene: %@\n"
    @"render layer: %@ %.0f x %.0f points, contentsScale %.2f, drawable %.0f x %.0f\n"
    @"render pixels per window pixel: %.2f%@\n"
    @"orientation: scene %ld, status bar %ld, device %ld, root VC supports 0x%lx, rotations sent %d\n"
    @"[PlayBridge] Spoofed device: %@ (%s), idiom: %@, isMacCatalystApp: NO, isiOSAppOnMac: NO\n",
    content.size.width, content.size.height, backing, content.size.width * backing, content.size.height * backing,
    screen.bounds.size.width, screen.bounds.size.height, screen.scale, screen.nativeBounds.size.width, screen.nativeBounds.size.height,
    NSStringFromCGRect(PBGameWindow().windowScene.coordinateSpace.bounds),
    layer ? NSStringFromClass([layer.delegate class]) : @"(none)", layer.bounds.size.width, layer.bounds.size.height, layer.contentsScale,
    layer.drawableSize.width, layer.drawableSize.height, sharpness, sharpness > 0 && sharpness < 0.9 ? @" (upscaled: the game renders below window resolution)" : @"",
    (long)PBGameWindow().windowScene.interfaceOrientation, (long)UIApplication.sharedApplication.statusBarOrientation,
    (long)UIDevice.currentDevice.orientation, (unsigned long)PBGameWindow().rootViewController.supportedInterfaceOrientations, gRotationsSent,
    PBDeviceModelName(), PBDeviceMachineIdentifier(), PBIsIPhone() ? @"Phone" : @"Pad"];
  NSString *caches = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Caches"];
  NSString *request = [caches stringByAppendingPathComponent:@"PlayBridge-snapshot.request"];
  if ([NSFileManager.defaultManager fileExistsAtPath:request]) {
    // Diagnostics: `touch` the request file to get a picture of what the game draws.
    [NSFileManager.defaultManager removeItemAtPath:request error:nil];
    UIWindow *w = PBGameWindow();
    UIGraphicsBeginImageContextWithOptions(w.bounds.size, YES, 1);
    [w drawViewHierarchyInRect:w.bounds afterScreenUpdates:NO];
    UIImage *image = UIGraphicsGetImageFromCurrentImageContext();
    UIGraphicsEndImageContext();
    [UIImagePNGRepresentation(image) writeToFile:[caches stringByAppendingPathComponent:@"PlayBridge-snapshot.png"] atomically:YES];
  }
  if ([text isEqual:gDisplayReport]) return;
  gDisplayReport = text;
  NSString *dir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Caches"];
  [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  [text writeToFile:[dir stringByAppendingPathComponent:@"PlayBridge-display.txt"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
}
@end

#pragma mark - Device & environment spoofing (iPad / iPhone emulation)

// Tells games and third-party engines (Unity, Unreal, NetEase NeoX, Cocos, etc.) that they
// are running on genuine iPad or iPhone hardware rather than a PC/Mac Catalyst desktop.

static NSString *gDeviceTypeOverride = nil;

static BOOL PBCalledByGame(void *caller) {
  Dl_info info;
  if (!dladdr(caller, &info) || !info.dli_fname) return YES;
  return strncmp(info.dli_fname, "/System/", 8) != 0 && strncmp(info.dli_fname, "/usr/lib/", 9) != 0;
}

static BOOL PBIsIPhone(void) {
  if (gDeviceTypeOverride) {
    return [gDeviceTypeOverride.lowercaseString containsString:@"iphone"];
  }
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  id family = info[@"UIDeviceFamily"];
  if ([family isKindOfClass:NSArray.class]) {
    NSArray *arr = (NSArray *)family;
    // UIDeviceFamily: 1 = iPhone, 2 = iPad. If it only contains 1 and not 2, it is iPhone-only.
    if ([arr containsObject:@(1)] && ![arr containsObject:@(2)]) {
      return YES;
    }
  } else if ([family isKindOfClass:NSNumber.class]) {
    if ([family intValue] == 1) return YES;
  }
  return NO;
}

static const char *PBDeviceMachineIdentifier(void) {
  return PBIsIPhone() ? "iPhone14,2" : "iPad13,8";
}

static NSString *PBDeviceModelName(void) {
  return PBIsIPhone() ? @"iPhone" : @"iPad";
}

static NSString *PBDeviceSystemName(void) {
  return PBIsIPhone() ? @"iOS" : @"iPadOS";
}

static void PBSwizzle(Class cls, SEL sel, IMP imp, IMP *original) {
  Method method = class_getInstanceMethod(cls, sel);
  if (!method) return;
  if (class_addMethod(cls, sel, imp, method_getTypeEncoding(method))) {
    if (original) *original = method_getImplementation(method);
  } else {
    IMP orig = method_setImplementation(method, imp);
    if (original) *original = orig;
  }
}

// 1. NSProcessInfo swizzling: hide Mac Catalyst & iOS App On Mac flags from the game
static BOOL (*gOrigIsMacCatalystApp)(id, SEL);
static BOOL PBIsMacCatalystApp(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? NO : (gOrigIsMacCatalystApp ? gOrigIsMacCatalystApp(self, _cmd) : NO);
}

static BOOL (*gOrigIsiOSAppOnMac)(id, SEL);
static BOOL PBIsiOSAppOnMac(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? NO : (gOrigIsiOSAppOnMac ? gOrigIsiOSAppOnMac(self, _cmd) : NO);
}

// 2. UIDevice swizzling: report genuine iOS device idiom (Pad/Phone) and names
static UIUserInterfaceIdiom (*gOrigUserInterfaceIdiom)(id, SEL);
static UIUserInterfaceIdiom PBUserInterfaceIdiom(id self, SEL _cmd) {
  if (PBCalledByGame(__builtin_return_address(0))) {
    return PBIsIPhone() ? UIUserInterfaceIdiomPhone : UIUserInterfaceIdiomPad;
  }
  return gOrigUserInterfaceIdiom ? gOrigUserInterfaceIdiom(self, _cmd) : UIUserInterfaceIdiomPad;
}

static NSString *(*gOrigModel)(id, SEL);
static NSString *PBModel(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? PBDeviceModelName() : (gOrigModel ? gOrigModel(self, _cmd) : PBDeviceModelName());
}

static NSString *(*gOrigLocalizedModel)(id, SEL);
static NSString *PBLocalizedModel(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? PBDeviceModelName() : (gOrigLocalizedModel ? gOrigLocalizedModel(self, _cmd) : PBDeviceModelName());
}

static NSString *(*gOrigName)(id, SEL);
static NSString *PBName(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? PBDeviceModelName() : (gOrigName ? gOrigName(self, _cmd) : PBDeviceModelName());
}

static NSString *(*gOrigSystemName)(id, SEL);
static NSString *PBSystemName(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? PBDeviceSystemName() : (gOrigSystemName ? gOrigSystemName(self, _cmd) : PBDeviceSystemName());
}

// 3. NSBundle swizzling: conceal CFBundleSupportedPlatforms = MacOSX & LSRequiresIPhoneOS = false from game queries
static id (*gOrigObjectForInfoDictionaryKey)(id, SEL, NSString *);
static id PBObjectForInfoDictionaryKey(NSBundle *self, SEL _cmd, NSString *key) {
  if (self == NSBundle.mainBundle && PBCalledByGame(__builtin_return_address(0))) {
    if ([key isEqualToString:@"CFBundleSupportedPlatforms"]) return @[ @"iPhoneOS" ];
    if ([key isEqualToString:@"LSRequiresIPhoneOS"]) return @YES;
  }
  return gOrigObjectForInfoDictionaryKey ? gOrigObjectForInfoDictionaryKey(self, _cmd, key) : nil;
}

static NSDictionary *(*gOrigInfoDictionary)(id, SEL);
static NSDictionary *PBInfoDictionary(NSBundle *self, SEL _cmd) {
  NSDictionary *dict = gOrigInfoDictionary ? gOrigInfoDictionary(self, _cmd) : nil;
  if (self == NSBundle.mainBundle && PBCalledByGame(__builtin_return_address(0)) && dict) {
    NSMutableDictionary *copy = [dict mutableCopy];
    copy[@"CFBundleSupportedPlatforms"] = @[ @"iPhoneOS" ];
    copy[@"LSRequiresIPhoneOS"] = @YES;
    return copy;
  }
  return dict;
}

// 4. POSIX C Interposing: sysctlbyname, sysctl, uname
int pb_sysctlbyname(const char *name, void *oldp, size_t *oldlenp, void *newp, size_t newlen) {
  if (name && (strcmp(name, "hw.machine") == 0 || strcmp(name, "hw.model") == 0)) {
    if (PBCalledByGame(__builtin_return_address(0))) {
      const char *fake = PBDeviceMachineIdentifier();
      size_t len = strlen(fake) + 1;
      if (oldlenp) {
        if (oldp) {
          if (*oldlenp < len) {
            errno = ENOMEM;
            return -1;
          }
          memcpy(oldp, fake, len);
        }
        *oldlenp = len;
      }
      return 0;
    }
  }
  return sysctlbyname(name, oldp, oldlenp, newp, newlen);
}
DYLD_INTERPOSE(pb_sysctlbyname, sysctlbyname);

int pb_sysctl(int *name, u_int namelen, void *oldp, size_t *oldlenp, void *newp, size_t newlen) {
  if (name && namelen >= 2 && name[0] == CTL_HW && (name[1] == HW_MACHINE || name[1] == HW_MODEL)) {
    if (PBCalledByGame(__builtin_return_address(0))) {
      const char *fake = PBDeviceMachineIdentifier();
      size_t len = strlen(fake) + 1;
      if (oldlenp) {
        if (oldp) {
          if (*oldlenp < len) {
            errno = ENOMEM;
            return -1;
          }
          memcpy(oldp, fake, len);
        }
        *oldlenp = len;
      }
      return 0;
    }
  }
  return sysctl(name, namelen, oldp, oldlenp, newp, newlen);
}
DYLD_INTERPOSE(pb_sysctl, sysctl);

int pb_uname(struct utsname *buf) {
  int ret = uname(buf);
  if (ret == 0 && buf && PBCalledByGame(__builtin_return_address(0))) {
    const char *fake = PBDeviceMachineIdentifier();
    strlcpy(buf->machine, fake, sizeof(buf->machine));
  }
  return ret;
}
DYLD_INTERPOSE(pb_uname, uname);

// 5. MobileGestalt MGCopyAnswer interception via dlsym
typedef CFPropertyListRef (*PBMGCopyAnswerFn)(CFStringRef property);
static PBMGCopyAnswerFn gRealMGCopyAnswer = NULL;

static CFPropertyListRef PBMGCopyAnswer(CFStringRef property) {
  static BOOL in_hook = NO;
  if (in_hook) return NULL;
  in_hook = YES;
  if (property && PBCalledByGame(__builtin_return_address(0))) {
    if (CFEqual(property, CFSTR("DeviceClass"))) {
      in_hook = NO;
      return CFRetain(PBIsIPhone() ? CFSTR("iPhone") : CFSTR("iPad"));
    }
    if (CFEqual(property, CFSTR("ProductType"))) {
      in_hook = NO;
      return CFRetain(PBIsIPhone() ? CFSTR("iPhone14,2") : CFSTR("iPad13,8"));
    }
    if (CFEqual(property, CFSTR("ArtworkDeviceIdiom"))) {
      in_hook = NO;
      return CFRetain(PBIsIPhone() ? CFSTR("phone") : CFSTR("pad"));
    }
    if (CFEqual(property, CFSTR("ArtworkCharacteristics"))) {
      NSDictionary *dict = @{ @"artwork-device-idiom": PBIsIPhone() ? @"phone" : @"pad",
                              @"artwork-device-subtype": @(2796) };
      in_hook = NO;
      return (CFPropertyListRef)CFBridgingRetain(dict);
    }
    if (CFEqual(property, CFSTR("ModelNumber"))) {
      in_hook = NO;
      return CFRetain(PBIsIPhone() ? CFSTR("MLQ73LL/A") : CFSTR("MHNH3LL/A"));
    }
    if (CFEqual(property, CFSTR("DeviceName"))) {
      in_hook = NO;
      return CFRetain((CFStringRef)PBDeviceModelName());
    }
  }
  if (!gRealMGCopyAnswer) {
    void *lib = dlopen("/usr/lib/libMobileGestalt.dylib", RTLD_LAZY | RTLD_GLOBAL);
    void *sym = lib ? dlsym(lib, "MGCopyAnswer") : NULL;
    if (sym && sym != (void *)PBMGCopyAnswer) gRealMGCopyAnswer = (PBMGCopyAnswerFn)sym;
  }
  CFPropertyListRef res = gRealMGCopyAnswer ? gRealMGCopyAnswer(property) : NULL;
  in_hook = NO;
  return res;
}

#pragma mark - In-memory / Persistent Keychain Mock for Catalyst

static NSString *PBKeychainFilePath(void) {
  NSString *home = [NSProcessInfo processInfo].environment[@"CFFIXED_USER_HOME"];
  if (home && home.length > 0) {
    NSString *libDir = [home stringByAppendingPathComponent:@"Library"];
    [[NSFileManager defaultManager] createDirectoryAtPath:libDir withIntermediateDirectories:YES attributes:nil error:nil];
    return [libDir stringByAppendingPathComponent:@".playbridge_keychain.plist"];
  }
  return @"/tmp/.playbridge_keychain.plist";
}

static NSMutableArray<NSMutableDictionary *> *gKeychainItems = nil;
static dispatch_once_t gKeychainOnce;
static os_unfair_lock gKeychainLock = OS_UNFAIR_LOCK_INIT;

static void PBLoadKeychain(void) {
  dispatch_once(&gKeychainOnce, ^{
    NSString *path = PBKeychainFilePath();
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (data) {
      NSError *err = nil;
      NSArray *arr = [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListMutableContainersAndLeaves format:NULL error:&err];
      if ([arr isKindOfClass:[NSArray class]]) {
        gKeychainItems = [arr mutableCopy];
      }
    }
    if (!gKeychainItems) {
      gKeychainItems = [NSMutableArray array];
    }
  });
}

static void PBSaveKeychain(void) {
  NSString *path = PBKeychainFilePath();
  NSError *err = nil;
  NSData *data = [NSPropertyListSerialization dataWithPropertyList:gKeychainItems format:NSPropertyListBinaryFormat_v1_0 options:0 error:&err];
  if (data) {
    [data writeToFile:path atomically:YES];
  }
}

static BOOL PBKeychainItemMatches(NSDictionary *item, NSDictionary *query) {
  for (id key in query) {
    if ([key isEqual:(id)kSecReturnData] ||
        [key isEqual:(id)kSecReturnAttributes] ||
        [key isEqual:(id)kSecReturnRef] ||
        [key isEqual:(id)kSecReturnPersistentRef] ||
        [key isEqual:(id)kSecMatchLimit] ||
        [key isEqual:(id)kSecMatchItemList] ||
        [key isEqual:(id)kSecMatchSearchList] ||
        [key isEqual:(id)kSecMatchCaseInsensitive] ||
        [key isEqual:(id)kSecValueData] ||
        [key isEqual:(id)kSecValueRef] ||
        [key isEqual:(id)kSecValuePersistentRef]) {
      continue;
    }
    id queryVal = query[key];
    id itemVal = item[key];
    if (!itemVal) return NO;
    if (![itemVal isEqual:queryVal]) return NO;
  }
  return YES;
}

static id PBKeychainFormatItem(NSDictionary *item, NSDictionary *query) {
  BOOL retData = [query[(id)kSecReturnData] boolValue];
  BOOL retAttrs = [query[(id)kSecReturnAttributes] boolValue];
  BOOL retRef = [query[(id)kSecReturnRef] boolValue];
  BOOL retPersistentRef = [query[(id)kSecReturnPersistentRef] boolValue];
  
  if (retRef) {
    id secClass = item[(id)kSecClass] ?: query[(id)kSecClass];
    NSData *data = item[(id)kSecValueData];
    if ([secClass isEqual:(id)kSecClassKey] && [data isKindOfClass:[NSData class]]) {
      NSMutableDictionary *keyParams = [NSMutableDictionary dictionary];
      keyParams[(id)kSecAttrKeyType] = (id)kSecAttrKeyTypeRSA;
      keyParams[(id)kSecAttrKeyClass] = (id)kSecAttrKeyClassPublic;
      CFErrorRef err = NULL;
      SecKeyRef keyRef = SecKeyCreateWithData((__bridge CFDataRef)data, (__bridge CFDictionaryRef)keyParams, &err);
      if (keyRef) {
        return (__bridge_transfer id)keyRef;
      }
    } else if ([secClass isEqual:(id)kSecClassCertificate] && [data isKindOfClass:[NSData class]]) {
      SecCertificateRef cert = SecCertificateCreateWithData(NULL, (__bridge CFDataRef)data);
      if (cert) {
        return (__bridge_transfer id)cert;
      }
    }
    if (!retData && !retAttrs) {
      return nil;
    }
  }
  
  if (retPersistentRef) {
    return [item[(id)kSecAttrAccount] dataUsingEncoding:NSUTF8StringEncoding] ?: item[(id)kSecValueData];
  }
  
  if (retData && retAttrs) {
    return [item copy];
  } else if (retData) {
    return item[(id)kSecValueData] ?: [NSData data];
  } else if (retAttrs) {
    NSMutableDictionary *attrs = [item mutableCopy];
    [attrs removeObjectForKey:(id)kSecValueData];
    return attrs;
  }
  return item[(id)kSecValueData] ?: [item copy];
}

OSStatus pb_SecItemCopyMatching(CFDictionaryRef query, CFTypeRef *result) {
  PBLoadKeychain();
  os_unfair_lock_lock(&gKeychainLock);
  
  NSDictionary *q = (__bridge NSDictionary *)query;
  id limit = q[(id)kSecMatchLimit];
  BOOL matchAll = [limit isEqual:(id)kSecMatchLimitAll];
  
  NSMutableArray *matches = [NSMutableArray array];
  for (NSDictionary *item in gKeychainItems) {
    if (PBKeychainItemMatches(item, q)) {
      id formatted = PBKeychainFormatItem(item, q);
      if (formatted) {
        [matches addObject:formatted];
        if (!matchAll) break;
      }
    }
  }
  
  os_unfair_lock_unlock(&gKeychainLock);
  
  if (matches.count == 0) {
    if (result) *result = NULL;
    return errSecItemNotFound;
  }
  
  if (result) {
    if (matchAll) {
      *result = (CFTypeRef)CFBridgingRetain(matches);
    } else {
      *result = (CFTypeRef)CFBridgingRetain(matches.firstObject);
    }
  }
  return errSecSuccess;
}
DYLD_INTERPOSE(pb_SecItemCopyMatching, SecItemCopyMatching);

OSStatus pb_SecItemAdd(CFDictionaryRef attributes, CFTypeRef *result) {
  PBLoadKeychain();
  os_unfair_lock_lock(&gKeychainLock);
  
  NSDictionary *attrs = (__bridge NSDictionary *)attributes;
  NSMutableDictionary *newItem = [NSMutableDictionary dictionary];
  
  for (id key in attrs) {
    id val = attrs[key];
    if ([val isKindOfClass:[NSString class]] ||
        [val isKindOfClass:[NSData class]] ||
        [val isKindOfClass:[NSNumber class]] ||
        [val isKindOfClass:[NSDate class]]) {
      newItem[key] = val;
    }
  }
  
  for (NSInteger i = (NSInteger)gKeychainItems.count - 1; i >= 0; i--) {
    NSDictionary *existing = gKeychainItems[i];
    id itemClass = attrs[(id)kSecClass];
    if (itemClass && ![existing[(id)kSecClass] isEqual:itemClass]) continue;
    
    if ([itemClass isEqual:(id)kSecClassKey]) {
      id tag = attrs[(id)kSecAttrApplicationTag];
      if (tag && [existing[(id)kSecAttrApplicationTag] isEqual:tag]) {
        [gKeychainItems removeObjectAtIndex:i];
      }
    } else {
      id acct = attrs[(id)kSecAttrAccount];
      id svc = attrs[(id)kSecAttrService];
      BOOL acctMatch = (!acct || [existing[(id)kSecAttrAccount] isEqual:acct]);
      BOOL svcMatch = (!svc || [existing[(id)kSecAttrService] isEqual:svc]);
      if (acct && svc && acctMatch && svcMatch) {
        [gKeychainItems removeObjectAtIndex:i];
      }
    }
  }
  
  [gKeychainItems addObject:newItem];
  PBSaveKeychain();
  
  if (result) {
    *result = (CFTypeRef)CFBridgingRetain(PBKeychainFormatItem(newItem, attrs));
  }
  
  os_unfair_lock_unlock(&gKeychainLock);
  return errSecSuccess;
}
DYLD_INTERPOSE(pb_SecItemAdd, SecItemAdd);

OSStatus pb_SecItemDelete(CFDictionaryRef query) {
  PBLoadKeychain();
  os_unfair_lock_lock(&gKeychainLock);
  
  NSDictionary *q = (__bridge NSDictionary *)query;
  BOOL deletedAny = NO;
  for (NSInteger i = (NSInteger)gKeychainItems.count - 1; i >= 0; i--) {
    if (PBKeychainItemMatches(gKeychainItems[i], q)) {
      [gKeychainItems removeObjectAtIndex:i];
      deletedAny = YES;
    }
  }
  
  if (deletedAny) {
    PBSaveKeychain();
  }
  
  os_unfair_lock_unlock(&gKeychainLock);
  return errSecSuccess;
}
DYLD_INTERPOSE(pb_SecItemDelete, SecItemDelete);

OSStatus pb_SecItemUpdate(CFDictionaryRef query, CFDictionaryRef attributesToUpdate) {
  PBLoadKeychain();
  os_unfair_lock_lock(&gKeychainLock);
  
  NSDictionary *q = (__bridge NSDictionary *)query;
  NSDictionary *updates = (__bridge NSDictionary *)attributesToUpdate;
  BOOL found = NO;
  
  for (NSMutableDictionary *item in gKeychainItems) {
    if (PBKeychainItemMatches(item, q)) {
      found = YES;
      for (id key in updates) {
        id val = updates[key];
        if ([val isKindOfClass:[NSString class]] ||
            [val isKindOfClass:[NSData class]] ||
            [val isKindOfClass:[NSNumber class]] ||
            [val isKindOfClass:[NSDate class]]) {
          item[key] = val;
        }
      }
    }
  }
  
  if (found) {
    PBSaveKeychain();
  }
  
  os_unfair_lock_unlock(&gKeychainLock);
  return found ? errSecSuccess : errSecItemNotFound;
}
DYLD_INTERPOSE(pb_SecItemUpdate, SecItemUpdate);

static void pb_abort(void);
static void pb_exit(int status);
static void pb__exit(int status);
static atomic_bool gPBTerminating;

void *pb_dlsym(void *handle, const char *symbol) {
  void *realSym = dlsym(handle, symbol);
  if (symbol) {
    if (strcmp(symbol, "MGCopyAnswer") == 0) {
      if (!gRealMGCopyAnswer && realSym && realSym != (void *)PBMGCopyAnswer) {
        gRealMGCopyAnswer = (PBMGCopyAnswerFn)realSym;
      }
      return (void *)PBMGCopyAnswer;
    }
    if (strcmp(symbol, "SecItemCopyMatching") == 0) return (void *)pb_SecItemCopyMatching;
    if (strcmp(symbol, "SecItemAdd") == 0) return (void *)pb_SecItemAdd;
    if (strcmp(symbol, "SecItemDelete") == 0) return (void *)pb_SecItemDelete;
    if (strcmp(symbol, "SecItemUpdate") == 0) return (void *)pb_SecItemUpdate;
    if (strcmp(symbol, "abort") == 0) return (void *)pb_abort;
    if (strcmp(symbol, "exit") == 0) return (void *)pb_exit;
    if (strcmp(symbol, "_exit") == 0) return (void *)pb__exit;
  }
  return realSym;
}
DYLD_INTERPOSE(pb_dlsym, dlsym);

int __kill(pid_t pid, int sig, int posix);

static int pb___kill(pid_t pid, int sig, int posix) {
  if (pid == getpid() || pid == 0) {
    return 0;
  }
  return __kill(pid, sig, posix);
}
DYLD_INTERPOSE(pb___kill, __kill);

static int pb_kill(pid_t pid, int sig) {
  if (pid == getpid() || pid == 0) {
    return 0;
  }
  return kill(pid, sig);
}
DYLD_INTERPOSE(pb_kill, kill);

static int pb_pthread_kill(pthread_t thread, int sig) {
  if (sig == SIGKILL || sig == SIGABRT || sig == SIGTERM || sig == SIGSEGV || sig == SIGBUS) {
    return 0;
  }
  return pthread_kill(thread, sig);
}
DYLD_INTERPOSE(pb_pthread_kill, pthread_kill);

static int pb_raise(int sig) {
  if (sig == SIGKILL || sig == SIGABRT || sig == SIGTERM) {
    return 0;
  }
  return raise(sig);
}
DYLD_INTERPOSE(pb_raise, raise);

static void pb_abort(void) {
  // Prevent deliberate anti-cheat watchdog crash from terminating game
}
DYLD_INTERPOSE(pb_abort, abort);

static void pb_exit(int status) {
  // Prevent anti-cheat suicide - but let the game's own exit through once it is really quitting (see PBBeginTermination).
  // Interposing does not apply inside this library, so exit() here is the real one.
  if (atomic_load(&gPBTerminating)) exit(status);
}
DYLD_INTERPOSE(pb_exit, exit);

static void pb__exit(int status) {
  // Prevent anti-cheat suicide (same exception as pb_exit)
  if (atomic_load(&gPBTerminating)) _exit(status);
}
DYLD_INTERPOSE(pb__exit, _exit);

#pragma mark - Clean shutdown

// Swallowing exit() also swallowed the game's own exit when the player quit: NeoX games then call game.on_exit() in a loop
// forever, logging each call (2026-10-22: Identity V wrote 64 GB of log in two hours and filled the disk) and the process
// never dies. Once the app is really quitting - UIKit's will-terminate, or SIGTERM/SIGINT/SIGHUP sent from OUTSIDE the
// process (kill/raise/pthread_kill on itself are still swallowed above, so anti-cheat cannot use this path) - exit() is let
// through and, if the game still has not exited after a grace period, the process is ended.
static const int kPBExitGraceSeconds = 5;
static dispatch_source_t gPBSignalSources[3];
static dispatch_source_t gPBDiskTimer;

static void PBBeginTermination(NSString *reason) {
  if (atomic_exchange(&gPBTerminating, true)) return;
  NSLog(@"PigPort: %@ - letting the game exit (forced after %d s)", reason, kPBExitGraceSeconds);
  // Not the main queue: a game stuck in its exit path keeps the main thread busy.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)kPBExitGraceSeconds * NSEC_PER_SEC),
                 dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSLog(@"PigPort: game did not exit within %d s - ending it", kPBExitGraceSeconds);
    _exit(0);
  });
}

// Free space on the volume holding the game's data; ULLONG_MAX on error (a failed check never stops the game).
static unsigned long long PBFreeBytes(void) {
  struct statfs st;
  if (statfs(NSHomeDirectory().fileSystemRepresentation, &st) != 0) return ULLONG_MAX;
  return (unsigned long long)st.f_bavail * st.f_bsize;
}

static void PBInstallShutdownGuards(unsigned long long minFreeBytes) {
  [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationWillTerminateNotification object:nil queue:nil
                                              usingBlock:^(NSNotification *note) { PBBeginTermination(@"app will terminate"); }];
  // Signal sources see deliveries even when the game installed its own handler (kqueue EVFILT_SIGNAL).
  const int sigs[] = {SIGTERM, SIGINT, SIGHUP};
  for (int i = 0; i < 3; i++) {
    int sig = sigs[i];
    dispatch_source_t src = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)sig, 0,
                                                   dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    dispatch_source_set_event_handler(src, ^{ PBBeginTermination([NSString stringWithFormat:@"received %s", strsignal(sig)]); });
    dispatch_resume(src);
    gPBSignalSources[i] = src;
  }
  // Last line of defence against any runaway writer: quit the game before the disk is full.
  gPBDiskTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  dispatch_source_set_timer(gPBDiskTimer, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), 30 * NSEC_PER_SEC, NSEC_PER_SEC);
  dispatch_source_set_event_handler(gPBDiskTimer, ^{
    unsigned long long left = PBFreeBytes();
    if (left < minFreeBytes) PBBeginTermination([NSString stringWithFormat:@"only %llu MB of disk space left", left >> 20]);
  });
  dispatch_resume(gPBDiskTimer);
}

static void PBEmptyAbortAfterSendingReport(id self, SEL _cmd) {
  // Suppress CrashSight abort action
}

static BOOL PBAlwaysFalseEnableAbort(id self, SEL _cmd) {
  return NO;
}

static void PBEmptySetEnableAbort(id self, SEL _cmd, BOOL val) {
  // Disallow enabling abort
}

static void PBDisableCrashSightAbort(void) {
  Class csClass = NSClassFromString(@"CSOperationManager");
  if (csClass) {
    SEL abortSel = NSSelectorFromString(@"abortAfterSendingReportIfNeed");
    if ([csClass instancesRespondToSelector:abortSel]) {
      PBSwizzle(csClass, abortSel, (IMP)PBEmptyAbortAfterSendingReport, NULL);
    }
    SEL enableSel = NSSelectorFromString(@"enableAbortAction");
    if ([csClass instancesRespondToSelector:enableSel]) {
      PBSwizzle(csClass, enableSel, (IMP)PBAlwaysFalseEnableAbort, NULL);
    }
    SEL setEnableSel = NSSelectorFromString(@"setEnableAbortAction:");
    if ([csClass instancesRespondToSelector:setEnableSel]) {
      PBSwizzle(csClass, setEnableSel, (IMP)PBEmptySetEnableAbort, NULL);
    }
  }
}

static void PBInstallDeviceSpoofing(void) {
  PBDisableCrashSightAbort();
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    PBDisableCrashSightAbort();
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    PBDisableCrashSightAbort();
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    PBDisableCrashSightAbort();
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    PBDisableCrashSightAbort();
  });

  Class piClass = NSProcessInfo.processInfo.class;
  PBSwizzle(piClass, @selector(isMacCatalystApp), (IMP)PBIsMacCatalystApp, (IMP *)&gOrigIsMacCatalystApp);
  if (piClass != NSProcessInfo.class) {
    PBSwizzle(NSProcessInfo.class, @selector(isMacCatalystApp), (IMP)PBIsMacCatalystApp, NULL);
  }
  SEL isiOSAppOnMacSel = NSSelectorFromString(@"isiOSAppOnMac");
  if ([NSProcessInfo.processInfo respondsToSelector:isiOSAppOnMacSel]) {
    PBSwizzle(piClass, isiOSAppOnMacSel, (IMP)PBIsiOSAppOnMac, (IMP *)&gOrigIsiOSAppOnMac);
    if (piClass != NSProcessInfo.class) {
      PBSwizzle(NSProcessInfo.class, isiOSAppOnMacSel, (IMP)PBIsiOSAppOnMac, NULL);
    }
  }

  Class devClass = UIDevice.currentDevice.class;
  PBSwizzle(devClass, @selector(userInterfaceIdiom), (IMP)PBUserInterfaceIdiom, (IMP *)&gOrigUserInterfaceIdiom);
  PBSwizzle(devClass, @selector(model), (IMP)PBModel, (IMP *)&gOrigModel);
  PBSwizzle(devClass, @selector(localizedModel), (IMP)PBLocalizedModel, (IMP *)&gOrigLocalizedModel);
  PBSwizzle(devClass, @selector(name), (IMP)PBName, (IMP *)&gOrigName);
  PBSwizzle(devClass, @selector(systemName), (IMP)PBSystemName, (IMP *)&gOrigSystemName);
  if (devClass != UIDevice.class) {
    PBSwizzle(UIDevice.class, @selector(userInterfaceIdiom), (IMP)PBUserInterfaceIdiom, NULL);
    PBSwizzle(UIDevice.class, @selector(model), (IMP)PBModel, NULL);
    PBSwizzle(UIDevice.class, @selector(localizedModel), (IMP)PBLocalizedModel, NULL);
    PBSwizzle(UIDevice.class, @selector(name), (IMP)PBName, NULL);
    PBSwizzle(UIDevice.class, @selector(systemName), (IMP)PBSystemName, NULL);
  }

  Class bundleClass = NSBundle.mainBundle.class;
  PBSwizzle(bundleClass, @selector(objectForInfoDictionaryKey:), (IMP)PBObjectForInfoDictionaryKey, (IMP *)&gOrigObjectForInfoDictionaryKey);
  PBSwizzle(bundleClass, @selector(infoDictionary), (IMP)PBInfoDictionary, (IMP *)&gOrigInfoDictionary);
  if (bundleClass != NSBundle.class) {
    PBSwizzle(NSBundle.class, @selector(objectForInfoDictionaryKey:), (IMP)PBObjectForInfoDictionaryKey, NULL);
    PBSwizzle(NSBundle.class, @selector(infoDictionary), (IMP)PBInfoDictionary, NULL);
  }
}

#pragma mark - Screen compatibility

// iOS reports UIScreen.nativeBounds in portrait-up orientation whatever the rotation, and
// engines such as Unity turn it to the game's orientation themselves. The Mac reports the
// display's landscape shape, so a landscape game rotated it to portrait and rendered a
// portrait frame stretched across the window. Report it the iOS way.
static CGRect (*gNativeBounds)(id, SEL);

static CGRect PBNativeBounds(id self, SEL _cmd) {
  CGRect bounds = gNativeBounds ? gNativeBounds(self, _cmd) : CGRectZero;
  if (PBCalledByGame(__builtin_return_address(0)) && bounds.size.width > bounds.size.height) {
    bounds.size = CGSizeMake(bounds.size.height, bounds.size.width);
  }
  return bounds;
}

static NSInteger (*gSceneOrientation)(id, SEL), (*gStatusBarOrientation)(id, SEL), (*gDeviceOrientation)(id, SEL);
static NSInteger (*gControllerOrientation)(id, SEL), (*gGeometryOrientation)(id, SEL);
static NSInteger PBControllerOrientation(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? UIInterfaceOrientationLandscapeRight : gControllerOrientation(self, _cmd);
}
static NSInteger PBGeometryOrientation(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? UIInterfaceOrientationLandscapeRight : gGeometryOrientation(self, _cmd);
}
static NSInteger PBSceneOrientation(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? UIInterfaceOrientationLandscapeRight : gSceneOrientation(self, _cmd);
}
static NSInteger PBStatusBarOrientation(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? UIInterfaceOrientationLandscapeRight : gStatusBarOrientation(self, _cmd);
}
static NSInteger PBDeviceOrientation(id self, SEL _cmd) {
  return PBCalledByGame(__builtin_return_address(0)) ? UIDeviceOrientationLandscapeLeft : gDeviceOrientation(self, _cmd);
}

static void PBReplace(Class cls, SEL sel, IMP imp, NSInteger (**original)(id, SEL)) {
  Method method = class_getInstanceMethod(cls, sel);
  if (method) *original = (NSInteger (*)(id, SEL))method_setImplementation(method, imp);
}

static void PBInstallScreenCompatibility(void) {
  Method method = class_getInstanceMethod(UIScreen.class, @selector(nativeBounds));
  if (method) gNativeBounds = (CGRect (*)(id, SEL))method_setImplementation(method, (IMP)PBNativeBounds);
  if (PBSupportedOrientation() <= 0) return;
  PBReplace(UIWindowScene.class, @selector(interfaceOrientation), (IMP)PBSceneOrientation, &gSceneOrientation);
  PBReplace(UIApplication.class, @selector(statusBarOrientation), (IMP)PBStatusBarOrientation, &gStatusBarOrientation);
  PBReplace(UIDevice.class, @selector(orientation), (IMP)PBDeviceOrientation, &gDeviceOrientation);
  PBReplace(UIViewController.class, NSSelectorFromString(@"interfaceOrientation"), (IMP)PBControllerOrientation, &gControllerOrientation);
  PBReplace(NSClassFromString(@"UIWindowSceneGeometry"), @selector(interfaceOrientation), (IMP)PBGeometryOrientation, &gGeometryOrientation);
}

#pragma mark - Text input detection

static __weak UIResponder *gFirstResponder;

@implementation UIResponder (PlayBridgeFirstResponder)
- (void)pb_reportFirstResponder:(id)sender { gFirstResponder = self; }
@end

// Typing in a chat or login field must not trigger mapped controls.
static BOOL PBTextInputActive(void) {
  gFirstResponder = nil;
  [UIApplication.sharedApplication sendAction:@selector(pb_reportFirstResponder:) to:nil from:nil forEvent:nil];
  return [gFirstResponder conformsToProtocol:@protocol(UIKeyInput)];
}

#pragma mark - Entry point

__attribute__((constructor)) static void PBInputInit(void) {
  const char *path = getenv("PLAYBRIDGE_KEYMAP");
  if (path && *path) gKeymapPath = @(path);
  const char *dev = getenv("PLAYBRIDGE_DEVICE_TYPE");
  if (dev && *dev) gDeviceTypeOverride = @(dev);
  const char *minFree = getenv("PLAYBRIDGE_MIN_FREE_MB");  // tests only; default 2 GB
  unsigned long long minFreeBytes = (minFree && *minFree ? strtoull(minFree, NULL, 10) : 2048ULL) << 20;
  // Keep the injection out of child processes and out of the game's environment.
  unsetenv("DYLD_INSERT_LIBRARIES");
  unsetenv("PLAYBRIDGE_KEYMAP");
  unsetenv("PLAYBRIDGE_DEVICE_TYPE");
  unsetenv("PLAYBRIDGE_MIN_FREE_MB");
  PBInstallShutdownGuards(minFreeBytes);
  PBInstallDeviceSpoofing();
  PBInstallScreenCompatibility();
  __block id observer = [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidFinishLaunchingNotification object:nil
                                                                         queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
    [NSNotificationCenter.defaultCenter removeObserver:observer];
    // Give the game a moment to create its window before showing the controls hint.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
      [PBWindowFit start];
      [PBInput.shared start];
    });
  }];
}
