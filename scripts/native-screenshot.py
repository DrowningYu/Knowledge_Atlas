#!/usr/bin/env python3
"""Capture an X11 test display without desktop tools (Linux smoke testing only)."""
import ctypes as C
import os, struct, zlib, sys
x = C.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[C.c_char_p];x.XOpenDisplay.restype=C.c_void_p
x.XDefaultRootWindow.argtypes=[C.c_void_p];x.XDefaultRootWindow.restype=C.c_ulong
x.XDisplayWidth.argtypes=[C.c_void_p,C.c_int];x.XDisplayHeight.argtypes=[C.c_void_p,C.c_int]
x.XGetImage.argtypes=[C.c_void_p,C.c_ulong,C.c_int,C.c_int,C.c_uint,C.c_uint,C.c_ulong,C.c_int];x.XGetImage.restype=C.c_void_p
x.XGetPixel.argtypes=[C.c_void_p,C.c_int,C.c_int];x.XGetPixel.restype=C.c_ulong
x.XDestroyImage.argtypes=[C.c_void_p];x.XCloseDisplay.argtypes=[C.c_void_p]
d=x.XOpenDisplay(os.environ.get('DISPLAY',':91').encode())
if not d: raise SystemExit('X11 display unavailable')
w,h=x.XDisplayWidth(d,0),x.XDisplayHeight(d,0)
im=x.XGetImage(d,x.XDefaultRootWindow(d),0,0,w,h,0xffffffff,2)
if not im:raise SystemExit('Capture failed')
raw=bytearray()
for y in range(h):
 raw.append(0)
 for a in range(w):
  p=x.XGetPixel(im,a,y);raw.extend(((p>>16)&255,(p>>8)&255,p&255))
def chunk(t,data):return struct.pack('>I',len(data))+t+data+struct.pack('>I',zlib.crc32(t+data)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
open(sys.argv[1] if len(sys.argv)>1 else 'native.png','wb').write(png)
x.XDestroyImage(im);x.XCloseDisplay(d)
print(f'Captured {w}x{h}')
