"""GRID knife models (Phase 27): a karambit and a butterfly knife, built in Blender and exported as GLB.

Run with Blender's Python (Blender 5.x, or the `bpy` module):
    python tools/knife-models.py public/weapons

Everything is generated here (no source files): the same script makes the same models. Conventions match the
M9 bayonet (m9_bayonet.glb) so the knives share its first-person fit: in the exported file the blade runs
along +Y from the guard at y = 0, the cutting edge faces -X, the blade's thickness is along Z, and the grip
lies below the guard (its middle about y = -0.06). Real sizes in metres. Materials are PBR colours only (no
textures), a few per model; the butterfly's two handles are separate nodes pivoting on their pins about Z
(`Handle_Safe`, `Handle_Bite`), so the game can swing them open.
"""

import math
import sys

import bpy  # noqa: E402  (bmesh is only available once bpy is loaded)
import bmesh  # noqa: E402

OUT = sys.argv[-1] if len(sys.argv) > 1 and not sys.argv[-1].endswith('.py') else 'public/weapons'


def to_blender(p):
    """glTF (x, y up, z) -> Blender (x, -z, y up): the exporter's +Y up turns it back."""
    x, y, z = p
    return (x, -z, y)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for m in list(bpy.data.materials):
        bpy.data.materials.remove(m)


MATS = {}


def material(name, color, metal, rough):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    MATS[name] = m
    return m


def mesh_object(name, verts, faces, mats, face_mats=None, parent=None, origin=(0, 0, 0), smooth_angle=35):
    """A mesh from glTF-space vertices; `origin` (glTF space) becomes the object origin (node position)."""
    me = bpy.data.meshes.new(name)
    o = [to_blender((v[0] - origin[0], v[1] - origin[1], v[2] - origin[2])) for v in verts]
    me.from_pydata(o, [], faces)
    for m in mats:
        me.materials.append(MATS[m])
    if face_mats:
        for poly, mi in zip(me.polygons, face_mats):
            poly.material_index = mi
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = to_blender(origin)
    if parent is not None:
        ob.parent = parent
        ob.location = to_blender((origin[0] - parent['origin'][0], origin[1] - parent['origin'][1], origin[2] - parent['origin'][2]))
    ob['origin'] = origin
    # Smooth where the surface curves, sharp at the bevels.
    for poly in me.polygons:
        poly.use_smooth = True
    bm = bmesh.new()
    bm.from_mesh(me)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(smooth_angle):
            e.smooth = False
    bm.to_mesh(me)
    bm.free()
    if hasattr(me, 'set_sharp_from_angle'):
        me.set_sharp_from_angle(angle=math.radians(smooth_angle))
    return ob


def merge(*parts):
    """Concatenates (verts, faces, face_mats) parts."""
    V, F, M = [], [], []
    for v, f, m in parts:
        b = len(V)
        V += v
        F += [[i + b for i in face] for face in f]
        M += m
    return V, F, M


def slab(outline, half, mat, z0=0.0, cap=True):
    """A flat piece: a closed 2D outline (x, y) extruded ±half along Z (its sides and both caps)."""
    n = len(outline)
    V = [(x, y, z0 + half) for x, y in outline] + [(x, y, z0 - half) for x, y in outline]
    F = []
    for i in range(n):
        j = (i + 1) % n
        F.append([i, j, n + j, n + i])
    if cap:
        F.append(list(range(n)))
        F.append(list(reversed(range(n, 2 * n))))
    return V, F, [mat] * len(F)


def rounded_rect(cx, cy, w, h, r, seg=4):
    pts = []
    for qx, qy, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        ox, oy = cx + qx * (w / 2 - r), cy + qy * (h / 2 - r)
        for s in range(seg + 1):
            a = math.radians(a0 + 90 * s / seg)
            pts.append((ox + r * math.cos(a), oy + r * math.sin(a)))
    return pts


def cylinder_z(cx, cy, r, half, mat, seg=12, z0=0.0):
    circle = [(cx + r * math.cos(2 * math.pi * k / seg), cy + r * math.sin(2 * math.pi * k / seg)) for k in range(seg)]
    return slab(circle, half, mat, z0)


def torus_z(cx, cy, R, r, mat, seg=28, ring=10):
    V, F = [], []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        for j in range(ring):
            b = 2 * math.pi * j / ring
            rr = R + r * math.cos(b)
            V.append((cx + rr * math.cos(a), cy + rr * math.sin(a), r * math.sin(b)))
    for i in range(seg):
        for j in range(ring):
            a, b2 = i * ring + j, i * ring + (j + 1) % ring
            c, d = ((i + 1) % seg) * ring + (j + 1) % ring, ((i + 1) % seg) * ring + j
            F.append([a, b2, c, d])
    return V, F, [mat] * len(F)


def blade(rail_spine, rail_grind, rail_edge, spine_half, steel, edge):
    """A blade from three rails of 2D points (spine, grind line, edge; same count, tip shared at the end):
    full thickness between spine and grind line, tapering to the edge. Steel flats, a bright bevel."""
    n = len(rail_spine)
    V, F, M = [], [], []

    def add(p):
        V.append(p)
        return len(V) - 1

    S_t = [add((x, y, spine_half)) for x, y in rail_spine]
    S_b = [add((x, y, -spine_half)) for x, y in rail_spine]
    G_t = [add((x, y, spine_half * 0.85)) for x, y in rail_grind]
    G_b = [add((x, y, -spine_half * 0.85)) for x, y in rail_grind]
    E_t = [add((x, y, spine_half * 0.12)) for x, y in rail_edge]
    E_b = [add((x, y, -spine_half * 0.12)) for x, y in rail_edge]
    for i in range(n - 1):
        F.append([S_t[i], G_t[i], G_t[i + 1], S_t[i + 1]]); M.append(steel)
        F.append([S_b[i + 1], G_b[i + 1], G_b[i], S_b[i]]); M.append(steel)
        F.append([G_t[i], E_t[i], E_t[i + 1], G_t[i + 1]]); M.append(edge)
        F.append([G_b[i + 1], E_b[i + 1], E_b[i], G_b[i]]); M.append(edge)
        F.append([S_b[i], S_t[i], S_t[i + 1], S_b[i + 1]]); M.append(steel)
        F.append([E_t[i], E_b[i], E_b[i + 1], E_t[i + 1]]); M.append(edge)
    # The heel (closed against the guard).
    F.append([S_t[0], S_b[0], G_b[0], G_t[0]]); M.append(steel)
    F.append([G_t[0], G_b[0], E_b[0], E_t[0]]); M.append(steel)
    return V, F, M


def export(name):
    bpy.ops.export_scene.gltf(
        filepath=f'{OUT}/{name}.glb',
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_texcoords=False,
        export_normals=True,
        export_materials='EXPORT',
        export_extras=True,
    )


# --- Karambit ----------------------------------------------------------------------------------------
# A claw blade curving toward the edge side from the guard, a G10-scaled full-tang handle and a steel
# finger ring at its end (in the blade's plane).

def karambit():
    reset()
    material('Blade_Steel', (0.42, 0.43, 0.44), 1.0, 0.38)
    material('Blade_Edge', (0.78, 0.79, 0.8), 1.0, 0.22)
    material('Handle_G10', (0.045, 0.05, 0.04), 0.0, 0.78)
    material('Ring_Steel', (0.16, 0.165, 0.17), 1.0, 0.42)
    material('Pin_Steel', (0.55, 0.56, 0.57), 1.0, 0.3)
    material('Handle_Groove', (0.012, 0.013, 0.011), 0.0, 0.9)

    # Blade: a centre line arcing from the guard toward -X (centre of the arc at (-R, 0)), its width tapering
    # to the point; the edge on the inner (concave, -X) side.
    R, sweep, N = 0.062, math.radians(118), 18
    spine, grind, edge = [], [], []
    for k in range(N + 1):
        t = k / N
        a = sweep * t
        cx, cy = -R + R * math.cos(a), R * math.sin(a)
        nx, ny = math.cos(a), math.sin(a)  # outward (spine side) normal of the arc
        w = 0.0125 * (1 - t ** 1.6) + 0.0006
        hook = 0.0016 * math.sin(math.pi * t)  # a slight belly
        spine.append((cx + nx * (w * 0.55), cy + ny * (w * 0.55)))
        grind.append((cx - nx * (w * 0.05 + hook * 0.3), cy - ny * (w * 0.05 + hook * 0.3)))
        edge.append((cx - nx * (w * 0.62 + hook), cy - ny * (w * 0.62 + hook)))
    edge[-1] = spine[-1] = grind[-1]
    b = blade(spine, grind, edge, 0.0021, 0, 1)

    # Guard / choil block at the heel.
    guard = slab(rounded_rect(-0.002, -0.004, 0.03, 0.007, 0.002), 0.0055, 2)
    # Tang (steel between the scales, visible as a strip) and two G10 scales with their pins.
    handle_outline = [(-0.011, -0.006), (0.012, -0.006), (0.014, -0.04), (0.012, -0.08), (0.0095, -0.104), (-0.0095, -0.104), (-0.012, -0.075), (-0.014, -0.045), (-0.012, -0.02)]
    tang = slab(handle_outline, 0.0016, 3)
    scale_out = [(x * 0.94, y) for x, y in handle_outline]
    scale_a = slab(scale_out, 0.0042, 2, z0=0.0058)
    scale_b = slab(scale_out, 0.0042, 2, z0=-0.0058)
    pins = merge(*(cylinder_z(0.0, y, 0.0021, 0.0102, 4, seg=10) for y in (-0.028, -0.07)))
    # Grip grooves across both scales (dark, slightly proud of the G10).
    grooves = merge(*(slab(rounded_rect(0.0, -0.038 - 0.007 * k, 0.019, 0.0018, 0.0008, seg=2), 0.0004, 5, z0=side * 0.0101) for k in range(5) for side in (1, -1)))
    # Finger ring at the end of the handle, in the blade's plane, joined by a short bolster.
    ring = torus_z(0.0, -0.124, 0.0155, 0.0042, 3)
    bolster = slab(rounded_rect(0.0, -0.106, 0.02, 0.008, 0.003), 0.0048, 3)
    V, F, M = merge(b, guard, tang, scale_a, scale_b, pins, ring, bolster, grooves)
    ob = mesh_object('Karambit', V, F, ['Blade_Steel', 'Blade_Edge', 'Handle_G10', 'Ring_Steel', 'Pin_Steel', 'Handle_Groove'], M)
    # Arm hints for the first-person hands (as the M9 file's extras would): none needed; grip middle as metadata.
    ob['grip_width'] = 0.026
    ob['grip_depth'] = 0.03
    export('karambit')
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    return tris


# --- Butterfly knife ---------------------------------------------------------------------------------
# A straight clip-point blade on a tang with two pivot pins; two channel handles (safe and bite), each a
# node pivoting on its own pin about Z; a latch on the bite handle's end. Exported open (handles together
# under the blade, as held); the game swings them from closed to open on the draw.

PIN_SAFE = (0.0062, -0.003, 0.0)
PIN_BITE = (-0.0062, -0.003, 0.0)


def butterfly():
    reset()
    material('Blade_Steel', (0.5, 0.51, 0.52), 1.0, 0.32)
    material('Blade_Edge', (0.8, 0.81, 0.82), 1.0, 0.2)
    material('Handle_Anodized', (0.06, 0.065, 0.07), 0.85, 0.42)
    material('Pin_Brass', (0.62, 0.47, 0.22), 1.0, 0.35)
    material('Latch_Steel', (0.4, 0.41, 0.42), 1.0, 0.3)
    material('Handle_Window', (0.01, 0.01, 0.012), 0.2, 0.7)

    # Blade: straight along +Y, clip point dipping toward the spine; edge on -X.
    N = 16
    L = 0.098
    spine, grind, edge = [], [], []
    for k in range(N + 1):
        t = k / N
        y = 0.004 + L * t
        clip = max(0.0, (t - 0.68) / 0.32)
        sx = 0.0105 - 0.0105 * clip ** 1.2
        ex = -0.0105 + 0.0105 * t ** 3.2
        spine.append((sx, y))
        grind.append((sx * 0.25 + ex * 0.75 + 0.002 * (1 - t), y))
        edge.append((ex, y))
    spine[-1] = grind[-1] = edge[-1] = (0.0, 0.004 + L)
    b = blade(spine, grind, edge, 0.0016, 0, 1)
    tang = slab([(-0.0105, 0.004), (0.0105, 0.004), (0.011, -0.008), (-0.011, -0.008)], 0.0016, 0)
    V, F, M = merge(b, tang)
    blade_ob = mesh_object('Blade', V, F, ['Blade_Steel', 'Blade_Edge'], M)

    # A channel handle (an open box of anodised plate) lying on one face of the blade, with its pin.
    def handle(name, pin, side, latch):
        z = side * 0.0045
        outline = rounded_rect(0.0, -0.06, 0.024, 0.112, 0.004)
        plate = slab(outline, 0.0012, 0, z0=z + side * 0.0012)
        # Channel walls toward the blade (so it reads as a channel from the side), and lighter grooves.
        walls = merge(
            slab([(0.0105, -0.006), (0.012, -0.006), (0.012, -0.114), (0.0105, -0.114)], 0.0018, 0, z0=z - side * 0.0006),
            slab([(-0.012, -0.006), (-0.0105, -0.006), (-0.0105, -0.114), (-0.012, -0.114)], 0.0018, 0, z0=z - side * 0.0006),
        )
        grooves = merge(*(slab(rounded_rect(0.0, -0.025 - 0.02 * k, 0.012, 0.009, 0.0035), 0.0003, 1, z0=z + side * 0.0026) for k in range(4)))
        pin_cap = cylinder_z(pin[0], pin[1], 0.0024, 0.0028, 2, seg=12, z0=side * 0.0042)
        parts = [plate, walls, grooves, pin_cap]
        if latch:
            parts.append(slab(rounded_rect(0.0, -0.1205, 0.014, 0.006, 0.0018), 0.001, 3, z0=z + side * 0.003))
        V, F, M = merge(*parts)
        return mesh_object(name, V, F, ['Handle_Anodized', 'Handle_Window', 'Pin_Brass', 'Latch_Steel'], M, origin=pin)

    safe = handle('Handle_Safe', PIN_SAFE, 1, False)
    bite = handle('Handle_Bite', PIN_BITE, -1, True)
    for o in (safe, bite):
        o['hinge'] = 'z'
    export('butterfly')
    return sum(len(p.vertices) - 2 for ob in (blade_ob, safe, bite) for p in ob.data.polygons)


if __name__ == '__main__':
    print('karambit tris', karambit())
    print('butterfly tris', butterfly())
