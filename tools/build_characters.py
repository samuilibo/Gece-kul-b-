#!/usr/bin/env python3
"""Builds the rigged character GLBs used by NEON CLUB LIVE.

Source data: MakeHuman / MPFB2 base mesh, morph targets, game_engine rig and weights
(all CC0, https://github.com/makehumancommunity/mpfb2). Clothes, hair and accessories
are derived procedurally from the base mesh helper geometry by this script, so the
result is CC0-derived + original work. See ASSET_LICENSES.md.

Usage: python3 tools/build_characters.py --mpfb /path/to/mpfb2 [--only m1]
Requires: numpy, pillow.
"""
import argparse
import gzip
import io
import json
import os
import random
import sys

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(__file__))
from mhlib import (GLB, SCALE, MHData, boundary_vertices, laplacian, nearest,  # noqa: E402
                   triangulate, vertex_normals)

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "characters")

REGIONS = {"skin": 0, "top": 1, "bottom": 2, "shoe": 3, "sole": 4, "hair": 5, "eye": 6,
           "dark": 7, "outer": 8, "hat": 9, "acc": 10, "lens": 11}

ARCHETYPES = [
    dict(id="m1", gender=1.0, race=dict(caucasian=1.0), muscle=0.55, weight=0.5, height=0.6, seed=11),
    dict(id="m2", gender=1.0, race=dict(african=1.0), muscle=0.7, weight=0.45, height=0.7, seed=12),
    dict(id="m3", gender=1.0, race=dict(asian=0.8, caucasian=0.2), muscle=0.4, weight=0.35, height=0.45, seed=13),
    dict(id="m4", gender=0.95, race=dict(caucasian=0.5, african=0.5), muscle=0.5, weight=0.75, height=0.5, seed=14),
    dict(id="f1", gender=0.0, race=dict(caucasian=1.0), muscle=0.5, weight=0.45, height=0.5, seed=21),
    dict(id="f2", gender=0.0, race=dict(african=1.0), muscle=0.55, weight=0.5, height=0.6, seed=22),
    dict(id="f3", gender=0.0, race=dict(asian=0.8, caucasian=0.2), muscle=0.45, weight=0.35, height=0.4, seed=23),
    dict(id="f4", gender=0.05, race=dict(caucasian=0.5, asian=0.5), muscle=0.5, weight=0.7, height=0.5, seed=24),
]

FACE_DIRS = ["nose", "chin", "cheek", "mouth", "eyes", "forehead", "head", "eyebrows", "ears"]


def tri3(v):
    if v < 0.5:
        return {"min": 1 - 2 * v, "average": 2 * v}
    return {"average": 2 - 2 * v, "max": 2 * v - 1}


def macro_targets(mh, a):
    out = []
    genders = {"male": a["gender"], "female": 1 - a["gender"]}
    mus, wt = tri3(a["muscle"]), tri3(a["weight"])
    for g, gw in genders.items():
        if gw <= 0:
            continue
        for mk, mw in mus.items():
            for wk, ww in wt.items():
                f = gw * mw * ww
                out.append((f"macrodetails/universal-{g}-young-{mk}muscle-{wk}weight", f))
                h = a["height"]
                if abs(h - 0.5) > 0.01:
                    out.append((f"macrodetails/height/{g}-young-{mk}muscle-{wk}weight-{'max' if h > 0.5 else 'min'}height",
                                f * abs(2 * h - 1)))
                out.append((f"macrodetails/proportions/{g}-young-{mk}muscle-{wk}weight-idealproportions", f * 0.5))
        for r, rw in a["race"].items():
            out.append((f"macrodetails/{r}-{g}-young", gw * rw))
    rnd = random.Random(a["seed"])
    tdir = os.path.join(mh.dir, "targets")
    for d in FACE_DIRS:
        files = sorted(f[:-10] for f in os.listdir(os.path.join(tdir, d)) if f.endswith(".target.gz"))
        files = [f for f in files if not f.startswith("r-") and "age" not in f]
        for f in rnd.sample(files, min(3, len(files))):
            w = rnd.uniform(0.2, 0.6)
            out.append((f"{d}/{f}", w))
            if f.startswith("l-") and os.path.exists(os.path.join(tdir, d, "r-" + f[2:] + ".target.gz")):
                out.append((f"{d}/r-{f[2:]}", w))
    return out


class Src:
    """A vertex pool + named triangle groups (parts)."""

    def __init__(self, P, UV, J, W, region):
        self.P, self.UV, self.J, self.W = P, UV, J, W
        self.R = np.full(len(P), region, dtype=np.uint8) if np.isscalar(region) else region
        self.N = None
        self.groups = {}  # name -> (T, extras)

    def all_tris(self):
        return np.concatenate([t for t, _ in self.groups.values()]) if self.groups else np.zeros((0, 3), np.int64)

    def finish(self, weld_key=None):
        T = self.all_tris()
        if weld_key is not None:
            # compute smooth normals across uv seams by welding on the original vertex id
            uniq, inv = np.unique(weld_key, return_inverse=True)
            Pw = np.zeros((len(uniq), 3))
            Pw[inv] = self.P
            self.N = vertex_normals(Pw, inv[T])[inv]
        else:
            self.N = vertex_normals(self.P, T)
        return self

    def lod(self, cell, cell_fn=None):
        """Vertex-clustering decimation."""
        c = np.full(len(self.P), cell) if cell_fn is None else cell_fn(self.P, cell)
        key = np.floor(self.P / c[:, None]).astype(np.int64)
        key = np.concatenate([key, (c * 1e5).astype(np.int64)[:, None], self.R[:, None].astype(np.int64)], axis=1)
        _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        inv = inv.reshape(-1)
        s = Src(self.P[first], self.UV[first], self.J[first], self.W[first], self.R[first])
        cnt = np.bincount(inv).astype(np.float64)
        acc = np.zeros((len(first), 3))
        np.add.at(acc, inv, self.P)
        s.P = acc / cnt[:, None]
        for name, (T, ex) in self.groups.items():
            T2 = inv[T]
            ok = (T2[:, 0] != T2[:, 1]) & (T2[:, 1] != T2[:, 2]) & (T2[:, 0] != T2[:, 2])
            T2 = T2[ok]
            if len(T2):
                T2 = np.unique(T2, axis=0)
            s.groups[name] = (T2, ex)
        s.N = vertex_normals(s.P, s.all_tris())
        return s


def prim(kind, **k):
    """Simple procedural meshes for accessories. Returns (P, T)."""
    if kind == "torus":
        R, r, nu, nv = k["R"], k["r"], k.get("nu", 20), k.get("nv", 6)
        a0, a1 = k.get("arc", (0, 2 * np.pi))
        closed = abs((a1 - a0) - 2 * np.pi) < 1e-6
        us = np.linspace(a0, a1, nu, endpoint=not closed)
        P, T = [], []
        for u in us:
            for j in range(nv):
                v = 2 * np.pi * j / nv
                P.append(((R + r * np.cos(v)) * np.cos(u), (R + r * np.cos(v)) * np.sin(u), r * np.sin(v)))
        n = len(us)
        for i in range(n if closed else n - 1):
            for j in range(nv):
                a, b = i * nv + j, i * nv + (j + 1) % nv
                c, d = ((i + 1) % n) * nv + j, ((i + 1) % n) * nv + (j + 1) % nv
                T += [(a, c, b), (b, c, d)]
        return np.array(P), np.array(T)
    if kind == "disc":
        R, n = k["R"], k.get("n", 16)
        P = [(0, 0, 0)] + [(R * np.cos(2 * np.pi * i / n), R * np.sin(2 * np.pi * i / n), 0) for i in range(n)]
        T = [(0, 1 + i, 1 + (i + 1) % n) for i in range(n)]
        return np.array(P), np.array(T)
    if kind == "box":
        a, b = np.array(k["a"], float), np.array(k["b"], float)
        P = np.array([[x, y, z] for x in (a[0], b[0]) for y in (a[1], b[1]) for z in (a[2], b[2])])
        T = np.array([(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1),
                      (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)])
        return P, T
    if kind == "sphere":
        R, nu, nv = k["R"], k.get("nu", 12), k.get("nv", 8)
        sc = np.array(k.get("scale", (1, 1, 1)), float)
        P, T = [], []
        for i in range(nv + 1):
            th = np.pi * i / nv
            for j in range(nu):
                ph = 2 * np.pi * j / nu
                P.append((R * np.sin(th) * np.cos(ph), R * np.cos(th), R * np.sin(th) * np.sin(ph)))
        for i in range(nv):
            for j in range(nu):
                a, b = i * nu + j, i * nu + (j + 1) % nu
                c, d = a + nu, b + nu
                T += [(a, b, c), (b, d, c)]
        return np.array(P) * sc, np.array(T)
    raise ValueError(kind)


def rigid(parts, bone, region, n_bones):
    """Merge primitive (P,T) lists into a Src bound to one bone."""
    Ps, Ts, off = [], [], 0
    for P, T in parts:
        Ps.append(P)
        Ts.append(T + off)
        off += len(P)
    P = np.concatenate(Ps)
    J = np.zeros((len(P), 4), np.uint8)
    J[:, 0] = bone
    W = np.zeros((len(P), 4), np.float32)
    W[:, 0] = 1
    return Src(P, np.zeros((len(P), 2)), J, W, region), np.concatenate(Ts)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def build(mh, a, mask_out=None):
    V = mh.morph(macro_targets(mh, a))
    P = V * SCALE
    ground = P[mh.group_range("joint-ground")].mean(axis=0)
    P = P - np.array([0, ground[1], 0])
    bones = mh.skeleton(P)
    nb = len(bones)
    bi = {b["name"]: i for i, b in enumerate(bones)}
    J, W = mh.skin(bones, len(P))
    jp = {b["name"]: b["head"] for b in bones}

    def chain_w(prefixes):
        ids = [i for i, b in enumerate(bones) if any(b["name"].startswith(p) for p in prefixes)]
        m = np.isin(J, ids)
        return (W * m).sum(axis=1)

    armS = chain_w(["upperarm", "lowerarm", "hand", "thumb", "index", "middle", "ring", "pinky"])
    legS = chain_w(["thigh", "calf", "foot", "ball"])
    headS = chain_w(["head"])

    def limb_t(a_, b_, c_):
        t = np.zeros(len(P))
        for side, sgn in (("l", 1), ("r", -1)):
            A, B, C = jp[f"{a_}_{side}"], jp[f"{b_}_{side}"], jp[f"{c_}_{side}"]
            tu = ((P - A) @ (B - A)) / ((B - A) @ (B - A))
            tl = ((P - B) @ (C - B)) / ((C - B) @ (C - B))
            tt = np.where(tu < 1, tu, 1 + np.maximum(tl, 0))
            m = (P[:, 0] * sgn) >= 0
            t[m] = tt[m]
        return t

    tA = limb_t("upperarm", "lowerarm", "hand")
    _ti = mh.group_range("helper-tights")
    tL = limb_t("thigh", "calf", "foot")
    X, Y, Z = P[:, 0], P[:, 1], P[:, 2]
    print("   tights tA max", tA[_ti][armS[_ti] > 0.5].max().round(2), "tL max", tL[_ti].max().round(2))
    hipY, neck, ankleY = jp["thigh_l"][1], jp["neck_01"], jp["foot_l"][1]
    pelvisY = jp["pelvis"][1]

    # ---- polygons per helper group
    def polys_in(idx):
        s = np.zeros(len(P), bool)
        s[idx] = True
        return [f for f in mh.faces if all(s[v] for v, _ in f)]

    def src_from_polys(polys, region, pos=None):
        """Unique (vi, ti) corners -> vertices."""
        pos = P if pos is None else pos
        tris = triangulate(polys)
        key = {}
        vid, T = [], []
        for t in tris:
            row = []
            for c in t:
                if c not in key:
                    key[c] = len(vid)
                    vid.append(c)
                row.append(key[c])
            T.append(row)
        vi = np.array([c[0] for c in vid])
        ti = np.array([c[1] for c in vid])
        uv = mh.VT[ti].copy()
        uv[:, 1] = 1 - uv[:, 1]
        s = Src(pos[vi].copy(), uv, J[vi], W[vi], region)
        return s, np.array(T, dtype=np.int64), vi

    sources = []

    # ---- tights-derived garments
    tights_idx = mh.group_range("helper-tights")
    tights_polys = polys_in(tights_idx)
    tT_all = np.array(triangulate([[v for v, _ in f] for f in tights_polys]))
    Nfull = vertex_normals(P, tT_all)
    tights_vpolys = [[v for v, _ in f] for f in tights_polys]
    rnd = np.random.default_rng(a["seed"])

    def garment(name, region, F, off, smooth=0, hide=True, src_polys=None, nsrc=None, noise=0.0, extra=None,
                extra_bone="head"):
        """Cuts a sheet out of helper geometry. F: scalar field over base vertices, > 0 inside.
        Faces crossing the F = 0 iso-line are kept and their outside vertices slide onto the
        line (clean hems). Optional rigid `extra` (P, T) pieces are appended to the same part."""
        src_polys = tights_vpolys if src_polys is None else src_polys
        nsrc = Nfull if nsrc is None else nsrc
        polys = [f for f in src_polys if any(F[v] > 0 for v in f)]
        if not polys:
            print("   (empty garment", name, ")")
            return None
        T = np.array(triangulate(polys))
        used = np.unique(T)
        remap = -np.ones(len(P), np.int64)
        remap[used] = np.arange(len(used))
        Tl = remap[T]
        Fu = F[used]
        B = P[used].copy()
        best = np.full(len(used), -1)
        bestF = np.zeros(len(used))
        bestD = np.full(len(used), 1e9)
        for f in polys:
            fl = remap[f]
            for u in fl:
                if Fu[u] <= 0:
                    for v in fl:
                        if Fu[v] > 0:  # nearest iso-line crossing wins
                            d = np.linalg.norm(B[u] - B[v]) * (-Fu[u]) / (Fu[v] - Fu[u])
                            if d < bestD[u]:
                                bestD[u], bestF[u], best[u] = d, Fu[v], v
        out = np.where((Fu <= 0) & (best >= 0))[0]
        tt = (bestF[out] / (bestF[out] - Fu[out]))[:, None]
        B[out] = B[best[out]] + (B[out] - B[best[out]]) * tt
        o = off(used) if callable(off) else np.full(len(used), off)
        if region == REGIONS["bottom"]:
            o = o * (1 - 0.75 * smoothstep(hipY - 0.09, hipY - 0.02, B[:, 1]))
        n = nsrc[used].copy()
        if region == REGIONS["shoe"]:
            o = np.where(n[:, 1] < -0.5, 0.002, o)
        Q = B + n * o[:, None]
        if smooth:
            Q = laplacian(Q, Tl, smooth, 0.5)
            Q = Q + vertex_normals(Q, Tl) * (0.0015 * smooth)
        if noise:
            Q = Q + vertex_normals(Q, Tl) * (rnd.random(len(Q))[:, None] * noise)
        s = Src(Q, np.zeros((len(used), 2)), J[used], W[used], region)
        interior = None
        if hide:
            bnd = boundary_vertices(Tl, len(used))
            interior = np.zeros(len(P), bool)
            interior[used[(~bnd) & (Fu > 0)]] = True
        for item in (extra or []):
            EP, ET = item[0], item[1]
            base = len(s.P)
            s.P = np.concatenate([s.P, EP])
            s.UV = np.concatenate([s.UV, np.zeros((len(EP), 2))])
            if len(item) > 2:
                Je, We = item[2], item[3]
            else:
                Je = np.zeros((len(EP), 4), np.uint8)
                Je[:, 0] = bi[extra_bone]
                We = np.zeros((len(EP), 4), np.float32)
                We[:, 0] = 1
            s.J = np.concatenate([s.J, Je])
            s.W = np.concatenate([s.W, We])
            s.R = np.concatenate([s.R, np.full(len(EP), region, np.uint8)])
            Tl = np.concatenate([Tl, ET + base])
        s.groups[name] = (Tl, {"part": name})
        s.finish()
        sources.append(s)
        return interior, F

    torso = (armS < 0.5)
    crew = neck[1] - 0.04 - 0.5 * (Z - neck[2]) + 4.0 * X * X - Y
    high = neck[1] + 0.012 - 0.25 * (Z - neck[2]) + 2.0 * X * X - Y
    hem = hipY - 0.005
    waist = pelvisY + 0.06
    BIG = 1.0

    def top_f(sleeve, collar, hem_y=hem, open_front=False):
        ft = np.minimum(Y - hem_y, collar)
        if open_front:
            ft = np.minimum(ft, np.where(Z > 0, np.abs(X) - 0.032, BIG))
        return np.where(armS >= 0.5, (sleeve - tA) * 0.25, ft)

    def bottom_f(length):
        return np.where(torso, np.where(legS < 0.5, waist - Y, np.minimum(waist - Y, (length - tL) * 0.4)), -1.0)

    hides = {}
    hides["top_tank"] = garment("top_tank", REGIONS["top"], top_f(0.06, crew), 0.006, 1)
    hides["top_tee"] = garment("top_tee", REGIONS["top"], top_f(0.55, crew), 0.010, 2)
    hides["top_long"] = garment("top_long", REGIONS["top"], top_f(1.9, crew), 0.008, 2)
    hides["top_hoodie"] = garment("top_hoodie", REGIONS["top"], top_f(1.92, high, hem - 0.03), 0.02, 5)
    hides["outer_jacket"] = garment("outer_jacket", REGIONS["outer"], top_f(1.93, high, hem + 0.02, True), 0.026, 4)
    hides["outer_vest"] = garment("outer_vest", REGIONS["outer"], top_f(0.04, high, hem + 0.03, True), 0.024, 4)
    hides["bot_pants"] = garment("bot_pants", REGIONS["bottom"], bottom_f(1.9), 0.010, 3)
    hides["bot_baggy"] = garment("bot_baggy", REGIONS["bottom"], bottom_f(1.93),
                                 lambda u: 0.014 + 0.03 * smoothstep(0.2, 1.9, tL[u]) * (legS[u] > 0.5), 5)
    hides["bot_shorts"] = garment("bot_shorts", REGIONS["bottom"], bottom_f(0.82), 0.016, 3)
    hides["bot_leggings"] = garment("bot_leggings", REGIONS["bottom"], bottom_f(1.9), 0.003, 0)
    hides["bot_under"] = garment("bot_under", REGIONS["bottom"], bottom_f(0.45), 0.003, 0)
    foot = (legS >= 0.5)
    hides["shoe_sneaker"] = garment("shoe_sneaker", REGIONS["shoe"], np.where(foot, ankleY + 0.04 - Y, -1.0), 0.011, 2)
    hides["shoe_boot"] = garment("shoe_boot", REGIONS["shoe"], np.where(foot, (tL - 1.5) * 0.4, -1.0), 0.013, 2)
    garment("acc_band", REGIONS["acc"], np.where((armS >= 0.5) & (X > 0), np.minimum(tA - 1.68, 1.9 - tA) * 0.25, -1.0),
            0.012, 0, hide=False)

    # sole: split low faces of each shoe into a 'sole' region part
    for s in sources:
        for name in list(s.groups):
            if name.startswith("shoe_"):
                T, ex = s.groups[name]
                low = (s.P[T][:, :, 1] < 0.022).all(axis=1)
                # duplicate verts for the sole so that the region is constant per vertex
                Ts = T[low]
                used = np.unique(Ts)
                base = len(s.P)
                rm = -np.ones(base, np.int64)
                rm[used] = base + np.arange(len(used))
                s.P = np.concatenate([s.P, s.P[used]])
                s.UV = np.concatenate([s.UV, s.UV[used]])
                s.J = np.concatenate([s.J, s.J[used]])
                s.W = np.concatenate([s.W, s.W[used]])
                s.N = np.concatenate([s.N, s.N[used]])
                s.R = np.concatenate([s.R, np.full(len(used), REGIONS["sole"], np.uint8)])
                s.groups[name] = (np.concatenate([T[~low], rm[Ts]]), ex)

    # ---- skirt (knee length) from helper-skirt
    skirt_idx = mh.group_range("helper-skirt")
    kneeY = jp["calf_l"][1]
    sk_polys = [f for f in polys_in(skirt_idx) if all(Y[v] > kneeY + 0.02 for v, _ in f)]
    s, T, vi = src_from_polys(sk_polys, REGIONS["bottom"])
    s.groups["bot_skirt"] = (T, {"part": "bot_skirt"})
    s.finish(vi)
    sources.append(s)

    # ---- body skin, split by "hidden by garment" signature
    body_idx = mh.group_range("body")
    body_polys = polys_in(body_idx)
    nbr, dist = nearest(P[body_idx], P[tights_idx])
    hide_names = [k for k in hides]
    cov = {}
    for k in hide_names:
        c = np.zeros(len(P), bool)
        c[body_idx] = hides[k][0][tights_idx[nbr]] & (dist < 0.04) & (hides[k][1][body_idx] > 0.012)
        cov[k] = c
    s, T, vi = src_from_polys(body_polys, REGIONS["skin"])
    sig = np.zeros(len(T), np.int64)
    for b, k in enumerate(hide_names):
        sig |= cov[k][vi[T]].all(axis=1).astype(np.int64) << b
    always = (1 << hide_names.index("shoe_sneaker")) | (1 << hide_names.index("top_tank")) | (1 << hide_names.index("bot_under"))
    for m in np.unique(sig):
        if (m & (1 << hide_names.index("shoe_sneaker"))) or \
           ((m & (1 << hide_names.index("top_tank"))) and (m & (1 << hide_names.index("top_tee")))) and False:
            continue
        if (m & (1 << hide_names.index("top_tank"))) or (m & (1 << hide_names.index("bot_under"))):
            continue  # torso / hips are covered by every outfit: never exported
        s.groups[f"skin_{m}"] = (T[sig == m], {"part": "skin", "hiddenBy": [hide_names[b] for b in range(len(hide_names)) if m >> b & 1]})
    del always
    s.finish(vi)
    sources.append(s)
    body_src, body_vi = s, vi

    # ---- eyes + lashes
    for side in "lr":
        e, T, vi = src_from_polys(polys_in(mh.group_range(f"helper-{side}-eye")), REGIONS["eye"])
        ec = P[mh.group_range(f"joint-{side}-eye")].mean(axis=0)
        dirs = e.P - ec
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        e.UV[:, 0] = np.arccos(np.clip(dirs[:, 2], -1, 1)) / np.pi  # 0 = looking straight ahead
        e.UV[:, 1] = 0
        e.groups[f"eye_{side}"] = (T, {"part": "eyes"})
        e.finish(vi)
        sources.append(e)
        lash = np.concatenate([mh.group_range(f"helper-{side}-eyelashes-1"), mh.group_range(f"helper-{side}-eyelashes-2")])
        e, T, vi = src_from_polys(polys_in(lash), REGIONS["dark"])
        e.groups[f"lash_{side}"] = (T, {"part": "eyes"})
        e.finish(vi)
        sources.append(e)

    # ---- hair
    def uv_layer_verts(name):
        u = json.load(gzip.open(os.path.join(mh.dir, "uv_layers", name + ".json.gz")))
        s_ = set()
        for k in u.keys():  # keys are polygon indices (values are per-loop uvs)
            s_.update(v for v, _ in mh.faces[int(k)])
        return s_

    scalp_v = uv_layer_verts("scalp_solid")
    scalp_polys = [[v for v, _ in f] for f in body_polys if all(v in scalp_v for v, _ in f)]
    body_T_all = np.array(triangulate([[v for v, _ in f] for f in body_polys]))
    Nbody = vertex_normals(P, body_T_all)
    head_top = jp["head"] + np.array([0, 0.11, 0.0])
    eye = P[mh.group_range("joint-l-eye")].mean(axis=0)
    eyeR = P[mh.group_range("joint-r-eye")].mean(axis=0)
    head_v = body_idx[(headS[body_idx] > 0.9)]
    ear_x = P[head_v][:, 0].max()
    ear_pt = P[head_v[P[head_v][:, 0].argmax()]]
    z_back = P[head_v][:, 2].min()
    cz = (eye[2] + z_back) / 2
    ONE = np.ones(len(P))

    def cap(name, region, off, smooth=0, noise=0.0, F=ONE, extra=None):
        garment(name, region, F, off, smooth, hide=False, src_polys=scalp_polys, nsrc=Nbody, noise=noise, extra=extra)

    def curtain(y_bot, curl=0.0, spread=1.75):
        """Hair sheet hanging from the cap around the back and sides of the head."""
        na, nr = 22, 8
        y_top = eye[1] + 0.055
        rx, rz = ear_x + 0.016, (cz - z_back) + 0.018
        Pc, Tc, Jc, Wc = [], [], [], []
        for i in range(nr + 1):
            v = i / nr
            y = y_top + (y_bot - y_top) * v
            yb_shape = 0.045 * v
            below = smoothstep(eye[1] - 0.06, eye[1] - 0.14, y)
            k = 0.86 + 0.14 * smoothstep(0.0, 0.35, v) - 0.10 * below + curl * (v ** 3) + 0.12 * smoothstep(neck[1] + 0.02, neck[1] - 0.08, y)
            for j in range(na + 1):
                th = (-spread + 2 * spread * j / na)
                wob = 1 + 0.035 * np.sin(j * 2.1 + i * 0.7)
                yy = y + yb_shape * (th / spread) ** 2
                Pc.append((np.sin(th) * rx * k * wob, yy, cz - np.cos(th) * rz * k * wob - 0.012 * below))
                wn = smoothstep(neck[1] + 0.06, neck[1] - 0.06, y) * 0.6
                Jc.append((bi["head"], bi["neck_01"], 0, 0))
                Wc.append((1 - wn, wn, 0, 0))
        for i in range(nr):
            for j in range(na):
                a_, b_ = i * (na + 1) + j, i * (na + 1) + j + 1
                c_, d_ = a_ + na + 1, b_ + na + 1
                Tc += [(a_, c_, b_), (b_, c_, d_)]
        return np.array(Pc), np.array(Tc), np.array(Jc, np.uint8), np.array(Wc, np.float32)

    back = np.array([0, jp["head"][1] + 0.075, jp["head"][2] - 0.085])
    crown = lambda lo, hi: smoothstep(eye[1] + lo, eye[1] + hi, Y)  # noqa: E731
    cap("hair_buzz", REGIONS["hair"], 0.0035)
    cap("hair_short", REGIONS["hair"], lambda u: 0.008 + 0.016 * crown(0.03, 0.10)[u], 1, 0.004)
    cap("hair_afro", REGIONS["hair"], lambda u: 0.012 + 0.055 * crown(0.0, 0.07)[u], 2, 0.008)
    bun_P, bun_T = prim("sphere", R=0.045, nu=12, nv=8)
    cap("hair_bun", REGIONS["hair"], 0.009, 1, 0.002, extra=[(bun_P + back + np.array([0, 0.06, 0.0]), bun_T)])
    tail_P, tail_T = prim("sphere", R=0.5, nu=10, nv=10)
    tail_P = tail_P * np.array([0.07, 0.36, 0.07])
    tail_P[:, 2] -= 0.10 * (0.18 - tail_P[:, 1]) * (tail_P[:, 1] < 0.18)
    cap("hair_pony", REGIONS["hair"], 0.009, 1, 0.002, extra=[(tail_P + back + np.array([0, -0.12, -0.03]), tail_T)])
    cap("hair_long", REGIONS["hair"], lambda u: 0.014 + 0.010 * crown(0.03, 0.10)[u], 1, 0.002,
        extra=[curtain(neck[1] - 0.055)])
    cap("hair_bob", REGIONS["hair"], lambda u: 0.012 + 0.010 * crown(0.03, 0.10)[u], 1, 0.002,
        extra=[curtain(neck[1] + 0.055, curl=-0.10, spread=1.9)])
    # lower halves only, worn under hats
    for nm, yb, cu in (("hair_long_low", neck[1] - 0.055, 0.0), ("hair_bob_low", neck[1] + 0.055, -0.10)):
        Pc, Tc, Jc, Wc = curtain(yb, cu)
        keep_t = (Pc[Tc][:, :, 1] < eye[1] + 0.03).all(axis=1)
        s = Src(Pc, np.zeros((len(Pc), 2)), Jc, Wc, REGIONS["hair"])
        s.groups[nm] = (Tc[keep_t], {"part": nm})
        sources.append(s.finish())

    # ---- hats
    brim_P, brim_T = prim("sphere", R=1, nu=14, nv=6)
    brim_P = brim_P * np.array([0.085, 0.006, 0.075])
    fore_z = max(P[v][2] for f in scalp_polys for v in f)
    cap("hat_cap", REGIONS["hat"], 0.02, 3, F=Y - (eye[1] + 0.038 + 0.22 * (Z - eye[2])),
        extra=[(brim_P + np.array([0, eye[1] + 0.046, fore_z + 0.045]), brim_T)])
    cap("hat_beanie", REGIONS["hat"], 0.024, 3, F=Y - (eye[1] + 0.026 + 0.16 * (Z - eye[2])))

    # ---- rigid accessories
    zf = eye[2] + 0.024

    def ring(center, R, r):
        Pp, Tt = prim("torus", R=R, r=r, nu=18, nv=5)
        return Pp * np.array([1.15, 0.9, 1]) + center, Tt

    def frames(r, lens):
        parts, lenses = [], []
        for c in (eye, eyeR):
            cc = np.array([c[0], c[1] - 0.002, zf])
            parts.append(ring(cc, 0.021, r))
            if lens:
                d, t = prim("disc", R=0.0215)
                lenses.append((d * np.array([1.15, 0.9, 1]) + cc, t))
        parts.append(prim("box", a=(-0.008, eye[1] + 0.002, zf - 0.002), b=(0.008, eye[1] + 0.006, zf + 0.002)))
        for sgn in (1, -1):
            x0 = sgn * (eye[0] + 0.026)
            x1 = sgn * (ear_x + 0.002)
            Pp, Tt = prim("box", a=(0, -0.002, 0), b=(1, 0.002, 1))
            Pp = np.stack([x0 + (x1 - x0) * Pp[:, 2] + sgn * 0.002 * Pp[:, 0], eye[1] + 0.004 + Pp[:, 1],
                           zf + (ear_pt[2] - zf) * Pp[:, 2]], axis=1)
            parts.append((Pp, Tt))
        return parts, lenses

    fr, _ = frames(0.0022, False)
    s, T = rigid(fr, bi["head"], REGIONS["acc"], nb)
    s.groups["acc_glasses"] = (T, {"part": "acc_glasses"})
    sources.append(s.finish())
    fr, ln = frames(0.003, True)
    s, T = rigid(fr, bi["head"], REGIONS["acc"], nb)
    s.groups["acc_shades"] = (T, {"part": "acc_shades"})
    sources.append(s.finish())
    s, T = rigid(ln, bi["head"], REGIONS["lens"], nb)
    s.groups["acc_shades_lens"] = (T, {"part": "acc_shades"})
    sources.append(s.finish())
    # headphones
    hc = np.array([0, ear_pt[1], ear_pt[2]])
    Rh = ear_x + 0.018
    top_h = head_top[1] - hc[1] + 0.035
    arc_P, arc_T = prim("torus", R=1, r=0.012, nu=20, nv=6, arc=(0, np.pi))
    arc_P = np.stack([arc_P[:, 0] * Rh + arc_P[:, 0] * 0, arc_P[:, 1] * top_h, arc_P[:, 2] * 1.6], axis=1)
    arc_P[:, 0] = np.where(np.abs(arc_P[:, 0]) > 0, arc_P[:, 0], 0)
    parts = [(arc_P + hc, arc_T)]
    for sgn in (1, -1):
        cP, cT = prim("sphere", R=0.036, nu=12, nv=8, scale=(0.5, 1.05, 1))
        parts.append((cP + hc + np.array([sgn * (Rh - 0.004), 0, 0]), cT))
    s, T = rigid(parts, bi["head"], REGIONS["acc"], nb)
    s.groups["acc_headphones"] = (T, {"part": "acc_headphones"})
    sources.append(s.finish())

    # ---- face mask texture (R lips, G brows, B unused=255, A beard)
    if mask_out:
        bake_mask(mh, P, body_src, body_vi, eye, jp, headS, uv_layer_verts("lips_solid"), mask_out)

    # ---- LODs
    def head_fine(Q, cell):
        return np.where(Q[:, 1] > neck[1] + 0.03, cell * 0.45, cell)

    lods = [sources,
            [s.lod(0.024, head_fine) for s in sources],
            [s.lod(0.06, head_fine) for s in sources],
            [s.lod(0.115, head_fine) for s in sources]]   # LOD3: GPU-instanced far crowd
    landmarks = {"height": float(P[body_idx][:, 1].max()), "eyeY": float(eye[1]), "headTop": float(head_top[1]),
                 "gender": "m" if a["gender"] > 0.5 else "f"}
    return bones, lods, landmarks


def bake_mask(mh, P, src, vi, eye, jp, headS, lips_v, path, size=1024):
    img = np.zeros((size, size, 4), np.float32)
    img[:, :, 2] = 1
    T = src.all_tris()
    lips = np.array([v in lips_v for v in vi])
    Q = P[vi]
    mouth = P[mh.group_range("joint-mouth")].mean(axis=0)
    ax = np.abs(Q[:, 0])
    # eyebrows: an arched band above each eye (front of face only)
    u = np.clip((ax - 0.010) / 0.046, 0, 1)
    arch = eye[1] + 0.0225 + 0.007 * np.sin(np.pi * np.minimum(u * 1.25, 1)) - 0.005 * u
    thick = 0.0042 * (1 - 0.55 * u)
    brow = np.clip(1.4 - np.abs(Q[:, 1] - arch) / thick, 0, 1) * (ax > 0.010) * (ax < 0.056) * (Q[:, 2] > eye[2] - 0.035)
    # beard: jaw + chin + upper lip
    lipY = mouth[1] + 0.012
    beard = smoothstep(lipY + 0.018, lipY + 0.004, Q[:, 1]) * (Q[:, 2] > eye[2] - 0.085 - ax * 0.2) * \
        smoothstep(jp["neck_01"][1] + 0.015, jp["neck_01"][1] + 0.045, Q[:, 1]) * (headS[vi] > 0.3)
    beard = np.maximum(beard, np.clip(1 - np.abs(Q[:, 1] - (lipY + 0.022)) / 0.008, 0, 1) * (ax < 0.03) * (Q[:, 2] > eye[2] - 0.02))
    val = np.stack([lips.astype(float), brow, np.ones(len(Q)), beard * (~lips)], axis=1)
    uv = src.UV * size
    sel = np.where((headS[vi][T] > 0.2).any(axis=1))[0]
    for f in sel:
        i0, i1, i2 = T[f]
        p0, p1, p2 = uv[i0], uv[i1], uv[i2]
        x0, x1 = int(max(0, np.floor(min(p0[0], p1[0], p2[0])))), int(min(size - 1, np.ceil(max(p0[0], p1[0], p2[0]))))
        y0, y1 = int(max(0, np.floor(min(p0[1], p1[1], p2[1])))), int(min(size - 1, np.ceil(max(p0[1], p1[1], p2[1]))))
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1])
        if abs(d) < 1e-9:
            continue
        w0 = ((p1[1] - p2[1]) * (xs - p2[0]) + (p2[0] - p1[0]) * (ys - p2[1])) / d
        w1 = ((p2[1] - p0[1]) * (xs - p2[0]) + (p0[0] - p2[0]) * (ys - p2[1])) / d
        w2 = 1 - w0 - w1
        m = (w0 >= -0.02) & (w1 >= -0.02) & (w2 >= -0.02)
        if not m.any():
            continue
        c = w0[..., None] * val[i0] + w1[..., None] * val[i1] + w2[..., None] * val[i2]
        reg = img[y0:y1 + 1, x0:x1 + 1]
        reg[m] = c[m]
    im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), "RGBA").filter(ImageFilter.GaussianBlur(1.2))
    im.save(path, optimize=True)


def write_glb(path, a, bones, lods, landmarks):
    g = GLB()
    g.j["extensionsUsed"] = ["KHR_mesh_quantization"]
    g.j["extensionsRequired"] = ["KHR_mesh_quantization"]
    nb = len(bones)
    # joint nodes: identity rest rotation, world-axis aligned (animation system relies on it)
    for i, b in enumerate(bones):
        par = bones[b["parent"]]["head"] if b["parent"] >= 0 else np.zeros(3)
        t = b["head"] - par
        node = {"name": b["name"], "translation": [float(x) for x in t],
                "extras": {"tail": [float(x) for x in (b["tail"] - b["head"])]}}
        g.j["nodes"].append(node)
    for i, b in enumerate(bones):
        if b["parent"] >= 0:
            g.j["nodes"][b["parent"]].setdefault("children", []).append(i)
    ibm = np.zeros((nb, 16), np.float32)
    for i, b in enumerate(bones):
        m = np.eye(4, dtype=np.float32)
        m[:3, 3] = -b["head"]
        ibm[i] = m.T.reshape(16)
    g.j["skins"] = [{"joints": list(range(nb)), "inverseBindMatrices": g.accessor(ibm, 5126, "MAT4"), "skeleton": 0}]
    root_children = [0]
    for li, sources in enumerate(lods):
        P = np.concatenate([s.P for s in sources]).astype(np.float32)
        N = np.concatenate([s.N for s in sources]).astype(np.float32)
        bad = np.linalg.norm(N, axis=1) < 1e-6
        N[bad] = (0.0, 1.0, 0.0)                     # degenerate (collapsed) vertices: avoid NaN shading
        UV = np.concatenate([s.UV for s in sources]).astype(np.float32)
        Jn = np.concatenate([s.J for s in sources]).astype(np.uint8)
        Wn = np.concatenate([s.W for s in sources]).astype(np.float32)
        Wn = Wn / np.maximum(Wn.sum(axis=1, keepdims=True), 1e-8)
        Wb = np.round(Wn * 255).astype(np.int32)
        Wb[:, 0] += 255 - Wb.sum(axis=1)
        R = np.concatenate([s.R for s in sources]).astype(np.uint8)
        assert len(P) < 65536, len(P)
        attrs = {
            "POSITION": g.accessor(P, 5126, "VEC3", target=34962, minmax=True),
            "NORMAL": g.accessor(np.pad(np.round(N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-8) * 127).astype(np.int8), ((0, 0), (0, 1))), 5120, "VEC3", normalized=True, target=34962, stride=4),
            "TEXCOORD_0": g.accessor(UV, 5126, "VEC2", target=34962),
            "JOINTS_0": g.accessor(Jn, 5121, "VEC4", target=34962),
            "WEIGHTS_0": g.accessor(Wb.astype(np.uint8), 5121, "VEC4", normalized=True, target=34962),
            "_REGION": g.accessor(np.pad(R[:, None], ((0, 0), (0, 3))), 5121, "VEC4", target=34962),
        }
        prims, off, tris = [], 0, 0
        for s in sources:
            for name, (T, ex) in s.groups.items():
                if len(T) == 0:
                    continue
                idx = (T + off).astype(np.uint16).reshape(-1)
                e = dict(ex)
                e["name"] = name
                prims.append({"attributes": attrs, "indices": g.accessor(idx, 5123, "SCALAR", target=34963), "extras": e})
                tris += len(T)
            off += len(s.P)
        g.j["meshes"].append({"name": f"LOD{li}", "primitives": prims})
        g.j["nodes"].append({"name": f"LOD{li}", "mesh": li, "skin": 0})
        root_children.append(len(g.j["nodes"]) - 1)
        print(f"  {a['id']} LOD{li}: {len(P)} verts, {tris} tris, {len(prims)} parts")
    g.j["nodes"].append({"name": a["id"], "children": root_children, "extras": landmarks})
    g.j["scenes"][0]["nodes"] = [len(g.j["nodes"]) - 1]
    g.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mpfb", default=os.environ.get("MPFB2_DIR", "../ext/mpfb2"))
    ap.add_argument("--makehuman", default=os.environ.get("MAKEHUMAN_DIR", ""))
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    mh = MHData(args.mpfb)
    manifest = []
    for i, a in enumerate(ARCHETYPES):
        if args.only and a["id"] not in args.only.split(","):
            continue
        print("building", a["id"])
        bones, lods, lm = build(mh, a, os.path.join(OUT, "face_mask.png") if a["id"] == "m1" else None)
        write_glb(os.path.join(OUT, a["id"] + ".glb"), a, bones, lods, lm)
        manifest.append({"id": a["id"], **lm})
    if not args.only:
        json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
    if args.makehuman:
        eye = os.path.join(args.makehuman, "makehuman", "data", "eyes", "materials", "brown_eye.png")
        Image.open(eye).convert("RGBA").resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "eye.png"), optimize=True)


if __name__ == "__main__":
    main()
