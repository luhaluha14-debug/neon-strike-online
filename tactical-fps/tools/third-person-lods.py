"""Third-person versions of the heaviest weapon files (Phase 27).

A character's weapon is small on screen, so it does not need the first-person model's full detail. This
script reduces the polygon count of each listed file (Blender's Decimate, collapse) and writes it to
public/weapons/tp/<name>.glb with the same nodes, names, transforms and materials, so the first-person fit
(grip, muzzle, parts) and the skins' material names hold unchanged. First person keeps the original files.

    python tools/third-person-lods.py public/weapons      (with the `bpy` module, e.g. pip install bpy)
"""

import os
import sys

import bpy

# File → target triangle count (about a fifth of the original or less).
TARGETS = {
    'm9_bayonet': 3000,
    'sr01': 4200,
    'ar01': 3600,
    'lmg02': 3600,
}


def triangles(objs):
    n = 0
    for o in objs:
        if o.type == 'MESH':
            n += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return n


def reduce(src, dst, target):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    before = triangles(meshes)
    ratio = min(1.0, target / max(before, 1))
    for o in meshes:
        # Small parts keep their shape (a pin, a sight post): only meshes with real detail are reduced.
        n = triangles([o])
        if n < 120:
            continue
        m = o.modifiers.new('lod', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = max(ratio, 60 / n)
        m.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = o
        for s in bpy.context.selected_objects:
            s.select_set(False)
        o.select_set(True)
        # Shared mesh data (instances) is made single-user first, as a modifier is applied per object.
        if o.data.users > 1:
            o.data = o.data.copy()
        bpy.ops.object.modifier_apply(modifier='lod')
    after = triangles(meshes)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format='GLB',
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_animations=False,
        export_extras=True,
    )
    print(f'{os.path.basename(src)}: {before} -> {after} triangles')


def main():
    root = sys.argv[-1] if len(sys.argv) > 1 and os.path.isdir(sys.argv[-1]) else 'public/weapons'
    for name, target in TARGETS.items():
        reduce(os.path.join(root, f'{name}.glb'), os.path.join(root, 'tp', f'{name}.glb'), target)


main()
