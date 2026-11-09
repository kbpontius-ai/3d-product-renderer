"""Reading CAD with Open CASCADE, for the ingestion pipeline (docs/23-cad-ingestion.md).

Run as a subprocess, never imported: OCCT is a large native C++ parser being handed a stranger's
file, and it belongs behind a process boundary and — in production — a container with no network.

  python3 occt_import.py request.json

The request names the source file, the levels of detail to produce, and where to put the results.
Geometry comes back as flat binary buffers rather than glTF, because the TypeScript side already
has an encoder whose output the mesh digests, the render dedupe and the parity baselines are all
keyed on. One encoder, one set of bytes.

Two channels out, because OCCT prints its own progress to stdout and would corrupt anything
structured there:

  * ``PR_PROGRESS <stage> <fraction>`` lines, which the supervisor parses and everything else
    ignores.
  * the result, written to the JSON path the request names.

Kept unmodified and at arm's length on purpose: OCCT is LGPL-2.1-with-exception, and a separate
process using it as published is the arrangement that keeps that simple.
"""

import json
import math
import os
import resource
import struct
import sys


def apply_limits():
    """Caps this process before it loads a kernel or reads a byte of the file.

    Deliberately the first thing that happens. These are the limits that survive an exploit: the
    namespace the supervisor put us in takes away the network, and these take away the ability to
    exhaust the machine — which a malformed shape can do in tessellation with no exploit involved
    at all.

    Belt and braces rather than the only belt: the supervisor also applies these through `prlimit`,
    which has them in force at `exec`, before any of this file runs. This half is what holds when
    the importer is invoked some other way — by hand, by a test, by a future caller that forgot.

    RLIMIT_CPU is the one worth understanding. It is not a duplicate of the supervisor's wall clock:
    that catches a process that is stuck, this catches one that is busy, and a tessellation spinning
    on a degenerate face is busy. The kernel sends SIGXCPU, so it lands even if the process has
    stopped cooperating.
    """
    def cap(kind, value, scale=1):
        if value <= 0:
            return
        limit = value * scale
        soft, hard = resource.getrlimit(kind)
        # Never raise a limit somebody else set lower — a container's ceiling wins over ours.
        ceiling = limit if hard == resource.RLIM_INFINITY else min(limit, hard)
        try:
            resource.setrlimit(kind, (ceiling, ceiling))
        except (ValueError, OSError) as error:
            # Darwin defines RLIMIT_AS and RLIMIT_DATA but its kernel refuses to set them, so the
            # belt this process can fasten itself is Linux-only. Said out loud rather than swallowed:
            # on a server CAD_SANDBOX=require already refuses to run here, and on a laptop reading
            # your own files an uncapped address space is the same trade the missing namespace is.
            sys.stderr.write('PR_LIMIT_SKIPPED %s %s\n' % (kind, error))
            sys.stderr.flush()

    cap(resource.RLIMIT_AS, int(os.environ.get('PR_CAD_MEMORY_MB', 0)), 1024 * 1024)
    cap(resource.RLIMIT_CPU, int(os.environ.get('PR_CAD_CPU_SECONDS', 0)))
    cap(resource.RLIMIT_FSIZE, int(os.environ.get('PR_CAD_MAX_OUTPUT_MB', 0)), 1024 * 1024)
    # No core dumps: a crash of this process would write the supplier's geometry to disk outside the
    # scratch directory the supervisor deletes.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


apply_limits()

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp, BRepGProp_Face
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.Bnd import Bnd_Box
from OCP.GProp import GProp_GProps
from OCP.GeomAbs import GeomAbs_SurfaceType
from OCP.Interface import Interface_Static
from OCP.ShapeAnalysis import ShapeAnalysis_Shell
from OCP.ShapeFix import ShapeFix_Shape
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label, TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_Orientation
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.gp import gp_Pnt, gp_Vec

MESH_MAGIC = b'PRMESH01'

# A direction has to be this close to a shared axis before a shape is called a body of revolution.
# Loose enough for a fillet's cone to count, tight enough that a bracket does not.
AXIS_TOLERANCE = 0.999
# And that axis has to carry this much of the curved surface area before it means anything.
AXIS_AREA_SHARE = 0.6


def progress(stage, fraction):
    sys.stderr.write('PR_PROGRESS %s %.4f\n' % (stage, fraction))
    sys.stderr.flush()


class Refused(Exception):
    """A failure that describes the file. The supervisor will not retry these."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# --- reading ------------------------------------------------------------------------------------


def read_document(path):
    """Reads the file into an XCAF document, which is what carries the assembly's part names.

    Part names are not decoration: the pack's material slots are drafted from them, so a reader that
    dropped them would turn every assembly into one anonymous lump.
    """
    # Ask OCCT to convert to millimetres as it reads. Every length past this point is in mm, which
    # is the one unit the rest of the system knows.
    Interface_Static.SetCVal_s('xstep.cascade.unit', 'MM')

    app = XCAFApp_Application.GetApplication_s()
    doc = TDocStd_Document(TCollection_ExtendedString('MDTV-XCAF'))
    app.NewDocument(TCollection_ExtendedString('MDTV-XCAF'), doc)

    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(False)
    reader.SetLayerMode(False)

    status = reader.ReadFile(path)
    if str(status) != 'IFSelect_ReturnStatus.IFSelect_RetDone':
        raise Refused('corrupt_file', 'the file could not be read as STEP (%s)' % status)
    if not reader.Transfer(doc):
        raise Refused('corrupt_file', 'the file was read but carried nothing transferable')

    return doc


def label_name(label):
    attribute = TDataStd_Name()
    if not label.FindAttribute(TDataStd_Name.GetID_s(), attribute):
        return None
    text = attribute.Get().ToExtString()
    text = text.strip() if text else ''
    # Exporters put their own name here when the part has none. It is not a part name, and letting
    # it through would make every pack's first material slot "Open CASCADE STEP translator".
    if not text or 'STEP translator' in text or text.lower() in ('compound', 'shape', 'unnamed'):
        return None
    return text


def referred_label(tool, label):
    """The prototype a component points at, or the component itself when it points at nothing.

    OCP binds `GetReferredShape` exactly as OCCT declares it — the label comes back through an out
    parameter and the return value only says whether there was one — so calling it the way the rest
    of `XCAFDoc_ShapeTool` reads, with one argument, raises `TypeError` on every assembly.
    """
    if not tool.IsReference_s(label):
        return label
    referred = TDF_Label()
    if not tool.GetReferredShape_s(label, referred):
        return label
    return referred


def collect_parts(doc, max_shapes, max_depth):
    """Every leaf shape in the document, with the name its CAD system gave it.

    Assemblies nest; this flattens them and records each part's parent, which is exactly the tree
    the pack drafting step reads back.
    """
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    roots = TDF_LabelSequence()
    tool.GetFreeShapes(roots)

    parts = []

    def walk(label, parent_index, depth):
        if depth > max_depth:
            raise Refused('too_complex', 'the assembly nests more than %d deep' % max_depth)
        if len(parts) >= max_shapes:
            raise Refused('too_complex', 'the file holds more than %d shapes' % max_shapes)

        if tool.IsAssembly_s(label):
            children = TDF_LabelSequence()
            tool.GetComponents_s(label, children)
            index = len(parts)
            parts.append({'label': label, 'name': label_name(label), 'parent': parent_index, 'shape': None})
            for i in range(1, children.Length() + 1):
                child = children.Value(i)
                referred = referred_label(tool, child)
                # The component carries the instance's name; the referred label carries the part's.
                # An instance name is the more specific of the two, so it wins when there is one.
                name = label_name(child) or label_name(referred)
                walk_named(referred, name, index, depth + 1)
            return

        shape = tool.GetShape_s(label)
        parts.append({'label': label, 'name': label_name(label), 'parent': parent_index, 'shape': shape})

    def walk_named(label, name, parent_index, depth):
        before = len(parts)
        walk(label, parent_index, depth)
        if len(parts) > before and name:
            parts[before]['name'] = name

    for i in range(1, roots.Length() + 1):
        walk(roots.Value(i), None, 0)

    leaves = [part for part in parts if part['shape'] is not None]
    if not leaves:
        raise Refused('no_solids', 'the file contains no shapes to tessellate')
    return parts


# --- healing and analysis -----------------------------------------------------------------------


def heal(shape):
    """Fixes what the exporter got wrong, and says what it fixed.

    A healed shape is not the shape the supplier sent. Somebody will eventually need to know that —
    usually the person holding a tool trial that does not match — so the repair is reported rather
    than quietly enjoyed.
    """
    if BRepCheck_Analyzer(shape).IsValid():
        return shape, None

    fix = ShapeFix_Shape(shape)
    fix.SetPrecision(1e-4)
    fix.SetMaxTolerance(1e-2)
    fix.Perform()
    fixed = fix.Shape()

    if BRepCheck_Analyzer(fixed).IsValid():
        return fixed, {'kind': 'other', 'count': 1, 'detail': 'ShapeFix_Shape made the shape valid'}
    # Still broken. Tessellation usually survives it, so this is a warning rather than a refusal —
    # but it goes in the record, because it is the likeliest explanation for a strange-looking pack.
    return fixed, {'kind': 'other', 'count': 1, 'detail': 'the shape is still invalid after repair'}


def bbox_of(shape):
    box = Bnd_Box()
    # The fast box can overestimate trimmed toroidal faces by millimetres. These bounds seed
    # physical pack dimensions, so measure the geometry independently of tessellation density.
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    if box.IsVoid():
        return None
    x0, y0, z0, x1, y1, z1 = box.Get()
    return [[x0, y0, z0], [x1, y1, z1]]


def watertight(shape):
    """Whether the shape is a closed, orientable solid.

    Not ``shape.Closed()``: that is a flag OCCT sets when it happens to know, and a shape read from
    STEP routinely arrives with it unset even when the solid is perfectly closed. Asking whether any
    shell has a free edge is a question about the geometry rather than about the bookkeeping, and it
    is the precondition that actually matters — volume, wall thickness and any boolean work all
    depend on it.
    """
    analysis = ShapeAnalysis_Shell()
    analysis.LoadShells(shape)
    analysis.CheckOrientedShells(shape, True)
    return not analysis.HasFreeEdges() and not analysis.HasBadEdges()


def volume_of(shape):
    props = GProp_GProps()
    # Fixed quadrature drifts on lofted spline faces, including valid exported thread geometry.
    BRepGProp.VolumeProperties_s(shape, props, 1e-9)
    value = props.Mass()
    # An open shell has no meaningful volume, and OCCT will still compute a number for one. Null is
    # the honest answer, and the contract asks for it.
    return value if math.isfinite(value) and value > 0 else None


def symmetry_axis(shapes):
    """The axis a body of revolution turns about, when there is one.

    Cylinders, cones and tori all declare their axis, so this is a tally rather than a fit: sum the
    surface area behind each direction and see whether one of them owns the shape. A closure does; a
    bracket does not, and reporting an axis for a bracket would put a "diameter" on the pack.
    """
    tally = {}
    total = 0.0

    for shape in shapes:
        explorer = TopExp_Explorer(shape, TopAbs_FACE)
        while explorer.More():
            face = TopoDS.Face_s(explorer.Current())
            explorer.Next()

            adaptor = BRepAdaptor_Surface(face)
            kind = adaptor.GetType()
            if kind == GeomAbs_SurfaceType.GeomAbs_Cylinder:
                direction = adaptor.Cylinder().Axis().Direction()
            elif kind == GeomAbs_SurfaceType.GeomAbs_Cone:
                direction = adaptor.Cone().Axis().Direction()
            elif kind == GeomAbs_SurfaceType.GeomAbs_Torus:
                direction = adaptor.Torus().Axis().Direction()
            else:
                continue

            props = GProp_GProps()
            BRepGProp.SurfaceProperties_s(face, props)
            area = props.Mass()
            if not math.isfinite(area) or area <= 0:
                continue

            vector = (direction.X(), direction.Y(), direction.Z())
            # An axis and its opposite are the same axis, so they are tallied together.
            if vector[0] + vector[1] + vector[2] < 0:
                vector = (-vector[0], -vector[1], -vector[2])

            for known in tally:
                if dot(known, vector) > AXIS_TOLERANCE:
                    tally[known] += area
                    break
            else:
                tally[vector] = area
            total += area

    if not tally or total <= 0:
        return None

    best = max(tally, key=lambda key: tally[key])
    if tally[best] / total < AXIS_AREA_SHARE:
        return None
    return [round(component, 6) for component in best]


def union(a, b):
    if a is None:
        return b
    return [
        [min(a[0][axis], b[0][axis]) for axis in range(3)],
        [max(a[1][axis], b[1][axis]) for axis in range(3)],
    ]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def declared_unit(path):
    """What the file says it is in, read from its DATA section.

    OCCT has already converted the geometry to millimetres by this point. This is for the record —
    and for the operator, because a file that turns out to have been in inches is the single most
    expensive thing that can go unnoticed here.
    """
    try:
        with open(path, 'r', encoding='latin-1', errors='replace') as handle:
            text = handle.read(2 * 1024 * 1024)
    except OSError:
        return None

    for needle, unit in (
        ('.MILLI.,.METRE.', 'mm'),
        ('.CENTI.,.METRE.', 'cm'),
        ('.KILO.,.METRE.', 'km'),
        ("'INCH'", 'in'),
        ("'FOOT'", 'ft'),
    ):
        if needle in text:
            return unit
    if '.METRE.' in text:
        return 'm'
    return None


# --- tessellation -------------------------------------------------------------------------------


def tessellate(shape, deflection, angular_deg):
    BRepMesh_IncrementalMesh(shape, deflection, False, math.radians(angular_deg), True)


def face_geometry(face):
    """One face's triangles, as positions, normals, UVs and indices.

    Two details that are easy to get wrong and expensive to notice later. Normals come from the
    surface rather than from averaging facets, so a cylinder is smooth at any tessellation — and
    ``BRepGProp_Face`` already accounts for the face's orientation, so they must not be flipped
    again. The winding does need flipping on a reversed face, or the triangles face inward and every
    render of the part is inside out.
    """
    location = TopLoc_Location()
    triangulation = BRep_Tool.Triangulation_s(face, location)
    if triangulation is None:
        return None

    transform = location.Transformation()
    reversed_face = face.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
    has_uv = triangulation.HasUVNodes()
    prop = BRepGProp_Face(face)

    positions = []
    normals = []
    uvs = []

    for node in range(1, triangulation.NbNodes() + 1):
        point = triangulation.Node(node).Transformed(transform)
        positions.extend((point.X(), point.Y(), point.Z()))

        if has_uv:
            uv = triangulation.UVNode(node)
            surface_point = gp_Pnt()
            normal = gp_Vec()
            prop.Normal(uv.X(), uv.Y(), surface_point, normal)
            if normal.Magnitude() > 1e-12:
                normal.Normalize()
                normals.extend((normal.X(), normal.Y(), normal.Z()))
            else:
                normals.extend((0.0, 0.0, 0.0))
            uvs.extend((uv.X(), uv.Y()))
        else:
            normals.extend((0.0, 0.0, 0.0))
            uvs.extend((0.0, 0.0))

    indices = []
    for index in range(1, triangulation.NbTriangles() + 1):
        a, b, c = triangulation.Triangle(index).Get()
        if reversed_face:
            b, c = c, b
        indices.extend((a - 1, b - 1, c - 1))

    return positions, normals, uvs, indices


def part_geometry(shape):
    """Every face of one part, welded into a single buffer.

    Faces are visited in ``TopExp_Explorer`` order, which is stable for a given shape — that
    stability is what makes two runs of the same file produce the same bytes, which render dedupe
    and every parity baseline depend on.
    """
    positions = []
    normals = []
    uvs = []
    indices = []

    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        explorer.Next()

        geometry = face_geometry(face)
        if geometry is None:
            continue

        offset = len(positions) // 3
        positions.extend(geometry[0])
        normals.extend(geometry[1])
        uvs.extend(geometry[2])
        indices.extend(index + offset for index in geometry[3])

    return positions, normals, uvs, indices


def write_buffer(path, blocks):
    """The wire format: a magic, then one block per part.

    Deliberately dull. It exists so the geometry can cross a process boundary without either side
    learning the other's data structures, and it is read exactly once, by ``mesh.ts``.
    """
    with open(path, 'wb') as handle:
        handle.write(MESH_MAGIC)
        handle.write(struct.pack('<I', len(blocks)))
        for positions, normals, uvs, indices in blocks:
            vertices = len(positions) // 3
            handle.write(struct.pack('<II', vertices, len(indices)))
            handle.write(struct.pack('<%df' % len(positions), *positions))
            handle.write(struct.pack('<%df' % len(normals), *normals))
            handle.write(struct.pack('<%df' % len(uvs), *uvs))
            handle.write(struct.pack('<%dI' % len(indices), *indices))


# --- the job ------------------------------------------------------------------------------------


def run(request):
    source = request['sourcePath']
    limits = request.get('limits', {})
    max_shapes = int(limits.get('maxShapes', 2000))
    max_depth = int(limits.get('maxAssemblyDepth', 16))
    max_triangles = int(limits.get('maxTrianglesTotal', 8000000))

    progress('parse', 0.1)
    document = read_document(source)
    nodes = collect_parts(document, max_shapes, max_depth)
    # Positions rather than objects: the blocks written per LOD are in leaf order, and the result
    # reports part indices in the flattened tree's order. This is the map between the two.
    leaf_indices = [index for index, node in enumerate(nodes) if node['shape'] is not None]
    leaves = [nodes[index] for index in leaf_indices]

    progress('heal', 0.3)
    repairs = []
    for node in leaves:
        node['shape'], repair = heal(node['shape'])
        if repair:
            repairs.append(repair)

    progress('analyse', 0.4)
    parts = []
    for node in nodes:
        shape = node['shape']
        parts.append(
            {
                'name': node['name'],
                'parentIndex': node['parent'],
                'bboxMm': bbox_of(shape) if shape is not None else None,
                'triangles': 0,
                'volumeMm3': volume_of(shape) if shape is not None else None,
                'watertight': watertight(shape) if shape is not None else False,
            }
        )

    # An assembly node has no geometry of its own, and the contract has no room for a part without a
    # bounding box. Giving it the union of what it contains is both true and useful: it is what an
    # operator means when they ask how big the sub-assembly is.
    for index in reversed(range(len(parts))):
        parent = parts[index]['parentIndex']
        if parent is None or parts[index]['bboxMm'] is None:
            continue
        parts[parent]['bboxMm'] = union(parts[parent]['bboxMm'], parts[index]['bboxMm'])

    boxes = [part['bboxMm'] for part in parts if part['bboxMm'] is not None]
    if not boxes:
        raise Refused('no_solids', 'nothing in the file has a measurable size')
    overall = boxes[0]
    for box in boxes[1:]:
        overall = union(overall, box)

    axis = symmetry_axis([node['shape'] for node in leaves])

    meshes = []
    total_triangles = 0
    for position, lod in enumerate(request['lods']):
        progress('tessellate', 0.4 + 0.5 * (position / max(len(request['lods']), 1)))

        blocks = []
        triangles = 0
        for node in leaves:
            tessellate(node['shape'], float(lod['deflectionMm']), float(lod['angularDeg']))
            geometry = part_geometry(node['shape'])
            blocks.append(geometry)
            triangles += len(geometry[3]) // 3

        total_triangles += triangles
        if triangles > int(lod['maxTriangles']) or total_triangles > max_triangles:
            raise Refused(
                'too_complex',
                '"%s" needs %d triangles, over what was allowed' % (lod['name'], triangles),
            )

        buffer_path = os.path.join(request['scratchDir'], '%s.bin' % lod['name'])
        write_buffer(buffer_path, blocks)
        meshes.append(
            {
                'lod': lod['name'],
                'bufferPath': buffer_path,
                'triangles': triangles,
                'parts': [
                    {'partIndex': leaf_indices[i], 'triangles': len(blocks[i][3]) // 3}
                    for i in range(len(leaves))
                ],
            }
        )

    # The finest tessellation is the one worth quoting a triangle count from, and it is the last.
    for entry in meshes[-1]['parts']:
        parts[entry['partIndex']]['triangles'] = entry['triangles']

    progress('write', 0.95)
    return {
        'status': 'ok',
        'declaredUnit': declared_unit(source),
        'bboxMm': overall,
        'parts': parts,
        'repairs': repairs,
        'meshes': meshes,
        'symmetryAxis': axis,
    }


def main():
    request = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
    result_path = request['resultPath']

    try:
        result = run(request)
    except Refused as refused:
        result = {'status': 'failed', 'failure': refused.code, 'message': str(refused)}
    except MemoryError:
        result = {'status': 'failed', 'failure': 'oom', 'message': 'the importer ran out of memory'}
    except Exception as error:  # noqa: BLE001 - the supervisor decides what a crash means, not this
        result = {
            'status': 'failed',
            'failure': 'importer_crash',
            'message': '%s: %s' % (type(error).__name__, error),
        }

    with open(result_path, 'w', encoding='utf-8') as handle:
        json.dump(result, handle)

    progress('write', 1.0)
    sys.exit(0 if result['status'] == 'ok' else 1)


main()
