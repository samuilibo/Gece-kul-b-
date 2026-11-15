"""MakeHuman / MPFB2 (CC0) data loading helpers + a minimal GLB writer.

Build-time only. Reads the CC0 base mesh, morph targets, rig and weights from a
local checkout of https://github.com/makehumancommunity/mpfb2 .
"""
import gzip
import json
import os
import struct

import numpy as np

SCALE = 0.1  # MakeHuman decimetres -> metres


class MHData:
    def __init__(self, root):
        self.root = root
        d = os.path.join(root, "src", "mpfb", "data")
        self.dir = d
        self._load_obj(os.path.join(d, "3dobjs", "base.obj"))
        self.vgroups = json.load(open(os.path.join(d, "mesh_metadata", "basemesh_vertex_groups.json")))
        self.rig = json.load(open(os.path.join(d, "rigs", "standard", "rig.game_engine.json")))
        self.weights = json.load(open(os.path.join(d, "rigs", "standard", "weights.game_engine.json")))["weights"]
        self._target_cache = {}

    def _load_obj(self, path):
        vs, vts, faces = [], [], []
        for line in open(path):
            if line.startswith("v "):
                p = line.split()
                vs.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("vt "):
                p = line.split()
                vts.append((float(p[1]), float(p[2])))
            elif line.startswith("f "):
                corners = []
                for c in line.split()[1:]:
                    a = c.split("/")
                    corners.append((int(a[0]) - 1, int(a[1]) - 1 if len(a) > 1 and a[1] else 0))
                faces.append(corners)
        self.V = np.array(vs, dtype=np.float64)
        self.VT = np.array(vts, dtype=np.float64)
        self.faces = faces  # polygons of (vi, ti)

    def group_range(self, name):
        idx = []
        for a, b in self.vgroups[name]:
            idx.extend(range(a, b + 1))
        return np.array(idx, dtype=np.int64)

    def target(self, rel):
        """Sparse morph target -> (indices, deltas) in decimetres."""
        if rel not in self._target_cache:
            idx, dl = [], []
            with gzip.open(os.path.join(self.dir, "targets", rel + ".target.gz"), "rt") as f:
                for line in f:
                    p = line.split()
                    if len(p) == 4 and not line.startswith("#"):
                        idx.append(int(p[0]))
                        dl.append((float(p[1]), float(p[2]), float(p[3])))
            self._target_cache[rel] = (np.array(idx, dtype=np.int64), np.array(dl, dtype=np.float64).reshape(-1, 3))
        return self._target_cache[rel]

    def uv_layer_faces(self, name):
        """Face indices (into self.faces) that belong to an MPFB uv layer mask."""
        u = json.load(gzip.open(os.path.join(self.dir, "uv_layers", name + ".json.gz")))
        return sorted(int(k) for k in u.keys())

    def morph(self, targets):
        V = self.V.copy()
        for rel, w in targets:
            if abs(w) < 1e-6:
                continue
            idx, dl = self.target(rel)
            V[idx] += dl * w
        return V

    def skeleton(self, P):
        """P: metre-space vertex positions. Returns bones in parent-first order."""
        def cube(name):
            return P[self.group_range(name)].mean(axis=0)

        names, done = [], set()
        pending = list(self.rig.keys())
        while pending:
            for n in list(pending):
                par = self.rig[n]["parent"]
                if not par or par in done:
                    names.append(n)
                    done.add(n)
                    pending.remove(n)
        bones = []
        for n in names:
            b = self.rig[n]
            head = cube(b["head"]["cube_name"])
            tail = cube(b["tail"]["cube_name"]) if b["tail"].get("cube_name") else head + np.array([0, 0.1, 0])
            par = b["parent"]
            bones.append({"name": n, "parent": names.index(par) if par else -1, "head": head, "tail": tail})
        return bones

    def skin(self, bones, n):
        """Top-4 normalised skin weights for all n base vertices."""
        acc = [[] for _ in range(n)]
        for bi, b in enumerate(bones):
            for vi, w in self.weights.get(b["name"], []):
                acc[vi].append((w, bi))
        J = np.zeros((n, 4), dtype=np.uint8)
        W = np.zeros((n, 4), dtype=np.float32)
        for vi, a in enumerate(acc):
            a.sort(reverse=True)
            a = a[:4]
            s = sum(w for w, _ in a) or 1.0
            for k, (w, bi) in enumerate(a):
                J[vi, k] = bi
                W[vi, k] = w / s
        return J, W


# --------------------------------------------------------------------------- mesh helpers

def triangulate(polys):
    tris = []
    for p in polys:
        for k in range(1, len(p) - 1):
            tris.append((p[0], p[k], p[k + 1]))
    return tris


def vertex_normals(P, T):
    n = np.zeros_like(P)
    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    fn = np.cross(b - a, c - a)
    for k in range(3):
        np.add.at(n, T[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln < 1e-12] = 1
    return n / ln


def laplacian(P, T, iters, lam=0.5, pinned=None):
    P = P.copy()
    n = len(P)
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]], T[:, [1, 0]], T[:, [2, 1]], T[:, [0, 2]]])
    for _ in range(iters):
        s = np.zeros_like(P)
        cnt = np.zeros(n)
        np.add.at(s, e[:, 0], P[e[:, 1]])
        np.add.at(cnt, e[:, 0], 1)
        cnt[cnt == 0] = 1
        avg = s / cnt[:, None]
        Q = P + (avg - P) * lam
        if pinned is not None:
            Q[pinned] = P[pinned]
        P = Q
    return P


def boundary_vertices(T, n):
    from collections import Counter
    c = Counter()
    for a, b, d in T:
        for u, v in ((a, b), (b, d), (d, a)):
            c[(min(u, v), max(u, v))] += 1
    out = np.zeros(n, dtype=bool)
    for (u, v), k in c.items():
        if k == 1:
            out[u] = out[v] = True
    return out


def nearest(A, B, chunk=2048):
    """For each point in A the index + distance of the nearest point in B."""
    idx = np.zeros(len(A), dtype=np.int64)
    dist = np.zeros(len(A))
    for s in range(0, len(A), chunk):
        d = np.linalg.norm(A[s:s + chunk, None, :] - B[None, :, :], axis=2)
        idx[s:s + chunk] = d.argmin(axis=1)
        dist[s:s + chunk] = d.min(axis=1)
    return idx, dist


# --------------------------------------------------------------------------- GLB writer

class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.j = {"asset": {"version": "2.0", "generator": "neon-club-live tools/build_characters.py"},
                  "buffers": [{}], "bufferViews": [], "accessors": [], "meshes": [], "nodes": [],
                  "scenes": [{"nodes": []}], "scene": 0}

    def view(self, data: bytes, target=None, stride=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            v["target"] = target
        if stride:
            v["byteStride"] = stride
        self.bin.extend(data)
        self.j["bufferViews"].append(v)
        return len(self.j["bufferViews"]) - 1

    def accessor(self, arr, ctype, atype, normalized=False, target=None, minmax=False, stride=None):
        arr = np.ascontiguousarray(arr)
        a = {"bufferView": self.view(arr.tobytes(), target, stride), "componentType": ctype,
             "count": int(arr.shape[0]), "type": atype}
        if normalized:
            a["normalized"] = True
        if minmax:
            a["min"] = [float(x) for x in arr.min(axis=0)]
            a["max"] = [float(x) for x in arr.max(axis=0)]
        self.j["accessors"].append(a)
        return len(self.j["accessors"]) - 1

    def image(self, png_bytes, name):
        self.j.setdefault("images", []).append({"bufferView": self.view(png_bytes), "mimeType": "image/png", "name": name})
        self.j.setdefault("samplers", [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}])
        self.j.setdefault("textures", []).append({"source": len(self.j["images"]) - 1, "sampler": 0, "name": name})
        return len(self.j["textures"]) - 1

    def save(self, path):
        self.j["buffers"][0]["byteLength"] = len(self.bin)
        js = json.dumps(self.j, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        b = bytes(self.bin) + b"\0" * ((4 - len(self.bin) % 4) % 4)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(b)))
            f.write(struct.pack("<II", len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack("<II", len(b), 0x004E4942))
            f.write(b)
