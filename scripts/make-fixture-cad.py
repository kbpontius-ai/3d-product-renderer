"""Writes the STEP fixtures. See make-fixture-cad.ts for why they are generated rather than typed."""

import os
import re
import math

from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon
from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeTorus
from OCP.STEPControl import STEPControl_StepModelType
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

HERE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'fixtures', 'cad')


# OCCT stamps the moment of writing into the header, which would make every regeneration a
# different file and every fixture diff unreadable. The date is not information about the fixture —
# it is information about whoever last ran this — so it is pinned.
FIXED_TIMESTAMP = '2026-01-01T00:00:00'


def normalise(path):
    """Removes the one thing in a STEP file that changes without the geometry changing.

    Worth the four lines: it makes `git diff` on a fixture show what actually moved, and it lets CI
    assert that the committed files are still what this script produces.
    """
    with open(path, 'r', encoding='latin-1') as handle:
        text = handle.read()

    # FILE_NAME's second argument is the timestamp. Matched rather than split on, because the first
    # argument is itself a quoted string and splitting gets that wrong in a way that silently
    # succeeds — which is how this was broken the first time.
    text = re.sub(
        r"(FILE_NAME\('[^']*',')[^']*(')",
        lambda match: match.group(1) + FIXED_TIMESTAMP + match.group(2),
        text,
        count=1,
    )

    with open(path, 'w', encoding='latin-1', newline='') as handle:
        handle.write(text)


def write(path, named_shapes):
    """One STEP file, with each shape carrying the name a real CAD system would give it.

    Names matter more than they look: the pack's material slots are drafted from them, so a fixture
    without names would never exercise the part of the pipeline most likely to be wrong.
    """
    app = XCAFApp_Application.GetApplication_s()
    doc = TDocStd_Document(TCollection_ExtendedString('MDTV-XCAF'))
    app.NewDocument(TCollection_ExtendedString('MDTV-XCAF'), doc)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    for name, shape in named_shapes:
        label = tool.AddShape(shape, False)
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))

    writer = STEPCAFControl_Writer()
    writer.Transfer(doc, STEPControl_StepModelType.STEPControl_AsIs)
    writer.Write(path)
    normalise(path)
    print('  %s' % os.path.relpath(path, os.path.dirname(HERE)))


os.makedirs(HERE, exist_ok=True)

# A 38 mm closure: one solid of revolution about Y, the shape the whole pipeline was sized for.
print('closure-38')
write(
    os.path.join(HERE, 'closure-38.step'),
    [('Cap body', BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 1, 0)), 19.0, 18.0).Shape())],
)

# Two named parts, so material slots, the assembly tree and per-part meshes all have something to
# be wrong about. A single-part fixture would pass a pipeline that silently merged everything.
print('closure-lined')
write(
    os.path.join(HERE, 'closure-lined.step'),
    [
        ('Cap body', BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 1, 0)), 19.0, 18.0).Shape()),
        ('Liner', BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 18, 0), gp_Dir(0, 1, 0)), 17.5, 1.2).Shape()),
    ],
)

# A box: no axis of revolution, so the drafter has to quote width/height/depth and add a side camera.
print('carton')
write(os.path.join(HERE, 'carton.step'), [('Board', BRepPrimAPI_MakeBox(80.0, 120.0, 40.0).Shape())])

# Cylinders alone cannot catch conservative toroidal bounds or fixed-quadrature spline drift.
# This synthetic fixture is independent of the supplier-derived packaging library.
loft = BRepOffsetAPI_ThruSections(True, False, 1e-7)
loft.CheckCompatibility(False)
for index in range(13):
    fraction = index / 12
    angle = fraction * 2 * math.pi
    radius = 4 + 1.5 * math.sin(3 * angle)
    section = BRepBuilderAPI_MakePolygon()
    for x, y in [(-radius, -radius), (radius, -radius), (radius, radius), (-radius, radius)]:
        section.Add(gp_Pnt(
            30 + x * math.cos(angle) - y * math.sin(angle),
            x * math.sin(angle) + y * math.cos(angle),
            20 * fraction,
        ))
    section.Close()
    loft.AddWire(section.Wire())
loft.Build()
if not loft.IsDone():
    raise RuntimeError('could not generate the curved metrology fixture')
write(os.path.join(HERE, 'curved-metrology.step'), [
    ('Rounded ring', BRepPrimAPI_MakeTorus(10.0, 2.0).Shape()),
    ('Twisted loft', loft.Shape()),
])
