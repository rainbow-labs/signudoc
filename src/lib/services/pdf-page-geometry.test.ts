import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePDFRawStream,
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
} from "pdf-lib";

import type { EnvelopeRecord } from "../schemas/envelope.ts";
import type { FieldRecord } from "../schemas/field.ts";
import type { SignerRecord } from "../schemas/signer.ts";
import { importPdfDocument } from "./document-import.ts";
import { renderFinalizedEnvelopePdf } from "./pdf-finalize.ts";
import {
  fieldOnDisplayedPage,
  type StoredPageSize,
} from "./pdf-page-geometry.ts";
import { prepareRevisionZero, prepareSignerRevision } from "./pdf-revision.ts";
import { sha256Hex } from "./pdf-seal.ts";
import type { StorageService } from "./storage.ts";

// A field is placed on the page as the browser shows it. These tests put one
// near the top left of the shown page, on pages that are rotated, cropped or
// whose box does not start at 0,0, and check where its value ends up in the
// page's own coordinates and on the page as pdf.js shows it.

type Box = [left: number, bottom: number, right: number, top: number];

type PageCase = {
  cropBox?: Box;
  /** The size of the page as shown. */
  displayed: { height: number; width: number };
  /** Where the field below is in the page's own coordinates. */
  fieldBox: Box;
  /** The `cm` operands that turn shown-page coordinates into the page's. */
  matrix: string | null;
  mediaBox: Box;
  name: string;
  rotate?: number;
};

// The field: a tenth in from the left, a twentieth down from the top, half
// the page wide and a tenth of it high.
const FIELD_RECT = { height: 0.1, width: 0.5, x: 0.1, y: 0.05 };
const VALUE = "Stamped";
const SIGNATURE = "Alice Example";

const PAGE_CASES: PageCase[] = [
  {
    displayed: { height: 800, width: 600 },
    fieldBox: [60, 680, 360, 760],
    matrix: null,
    mediaBox: [0, 0, 600, 800],
    name: "an ordinary page",
  },
  {
    // The top left of the shown page is the bottom left of the page itself.
    displayed: { height: 600, width: 800 },
    fieldBox: [30, 80, 90, 480],
    matrix: "0 1 -1 0 600 0",
    mediaBox: [0, 0, 600, 800],
    name: "a page rotated 90",
    rotate: 90,
  },
  {
    displayed: { height: 800, width: 600 },
    fieldBox: [240, 40, 540, 120],
    matrix: "-1 0 0 -1 600 800",
    mediaBox: [0, 0, 600, 800],
    name: "a page rotated 180",
    rotate: 180,
  },
  {
    displayed: { height: 600, width: 800 },
    fieldBox: [510, 320, 570, 720],
    matrix: "0 -1 1 0 0 800",
    mediaBox: [0, 0, 600, 800],
    name: "a page rotated 270",
    rotate: 270,
  },
  {
    cropBox: [50, 100, 450, 700],
    displayed: { height: 600, width: 400 },
    fieldBox: [90, 610, 290, 670],
    matrix: "1 0 0 1 50 100",
    mediaBox: [0, 0, 600, 800],
    name: "a page with a CropBox",
  },
  {
    displayed: { height: 800, width: 600 },
    fieldBox: [160, 880, 460, 960],
    matrix: "1 0 0 1 100 200",
    mediaBox: [100, 200, 700, 1000],
    name: "a page whose MediaBox does not start at 0,0",
  },
  {
    cropBox: [150, 300, 550, 900],
    displayed: { height: 400, width: 600 },
    fieldBox: [170, 360, 210, 660],
    matrix: "0 1 -1 0 550 300",
    mediaBox: [100, 200, 700, 1000],
    name: "a rotated, cropped page with a shifted MediaBox",
    rotate: 90,
  },
];

const now = 1_800_000_000;

async function makeSource(pageCase: PageCase): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const [left, bottom, right, top] = pageCase.mediaBox;
  const page = document.addPage([right - left, top - bottom]);

  page.setMediaBox(left, bottom, right - left, top - bottom);

  if (pageCase.cropBox) {
    const [cropLeft, cropBottom, cropRight, cropTop] = pageCase.cropBox;

    page.setCropBox(
      cropLeft,
      cropBottom,
      cropRight - cropLeft,
      cropTop - cropBottom,
    );
  }

  if (pageCase.rotate) {
    page.setRotation(degrees(pageCase.rotate));
  }

  return document.save();
}

function field(overrides: Partial<FieldRecord>): FieldRecord {
  return {
    ...FIELD_RECT,
    createdAt: now - 500,
    envelopeId: "envelope-1",
    page: 1,
    required: true,
    signerId: "signer-1",
    submittedAt: now,
    type: "text",
    updatedAt: now,
    ...overrides,
  } as FieldRecord;
}

/** The stored size of an envelope imported since sizes are read as shown. */
function shownSize(pageCase: PageCase): StoredPageSize[] {
  return [
    {
      heightPt: pageCase.displayed.height,
      pageNumber: 1,
      widthPt: pageCase.displayed.width,
    },
  ];
}

async function finalize(
  sourcePdf: Uint8Array,
  fields: FieldRecord[],
  pages: StoredPageSize[],
): Promise<Uint8Array> {
  const envelope: EnvelopeRecord = {
    completedAt: now,
    createdAt: now - 500,
    declinedAt: null,
    evidenceKey: null,
    id: "envelope-1",
    pageCount: 1,
    sentAt: now - 400,
    signedPdfKey: null,
    sourcePdfFilename: "scan.pdf",
    sourcePdfHash: sha256Hex(sourcePdf),
    sourcePdfKey: "source.pdf",
    sourcePdfSizeBytes: sourcePdf.byteLength,
    status: "completed",
    title: "Scan",
    updatedAt: now,
    userId: "user-1",
    voidedAt: null,
  };
  const signers: SignerRecord[] = [
    {
      createdAt: now - 500,
      email: "alice@example.com",
      id: "signer-1",
      name: "Alice Example",
      signedAt: now,
      signOrder: 1,
      status: "signed",
      updatedAt: now,
    },
  ];
  const storageService = {
    getObject: async () => ({
      body: sourcePdf,
      contentLength: sourcePdf.byteLength,
      contentType: "application/pdf",
    }),
  } as unknown as StorageService;

  return renderFinalizedEnvelopePdf(
    {
      auditEvents: [],
      completedAt: now,
      envelope,
      fields,
      pages,
      signers,
      sourcePdfKey: envelope.sourcePdfKey,
    },
    {
      seal: (pdfDocument: PDFDocument) => pdfDocument.save(),
      storageService,
    },
  );
}

type PlacedText = {
  /** Where the text starts in the page's own coordinates. */
  user: { x: number; y: number };
  /** The text's matrix on the shown page (y runs down). */
  viewport: number[];
  viewportSize: { height: number; width: number };
};

/** Where pdf.js finds a piece of text on the first page. */
async function findText(pdfBytes: Uint8Array, text: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const page = await document.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const item = (
    content.items as Array<{ str?: string; transform?: number[] }>
  ).find((entry) => entry.str === text);
  const placed: PlacedText | null = item?.transform
    ? {
        user: { x: item.transform[4]!, y: item.transform[5]! },
        viewport: pdfjs.Util.transform(viewport.transform, item.transform),
        viewportSize: { height: viewport.height, width: viewport.width },
      }
    : null;

  await document.destroy();

  return placed;
}

/** The value is in the field and upright, on the page as pdf.js shows it. */
function assertShownInField(placed: PlacedText, pageCase: PageCase) {
  assert.deepEqual(placed.viewportSize, pageCase.displayed);
  assertInside(placed.user, pageCase.fieldBox, "in the page's coordinates");

  // On the shown page y runs down from the top, as it does for the field.
  const { height, width } = pageCase.displayed;

  assertInside(
    { x: placed.viewport[4]!, y: placed.viewport[5]! },
    [
      FIELD_RECT.x * width,
      FIELD_RECT.y * height,
      (FIELD_RECT.x + FIELD_RECT.width) * width,
      (FIELD_RECT.y + FIELD_RECT.height) * height,
    ],
    "on the shown page",
  );

  // Upright as shown: it runs left to right and is not turned.
  assert.ok(placed.viewport[0]! > 0 && placed.viewport[3]! < 0);
  assert.ok(Math.abs(placed.viewport[1]!) < 0.001);
  assert.ok(Math.abs(placed.viewport[2]!) < 0.001);
}

/**
 * The page with nothing on it but one annotation's appearance, drawn the way
 * a reader draws it: the appearance's box, moved by its own matrix, is fitted
 * to the annotation's rectangle (PDF 32000-1, 12.5.5). pdf.js does not read
 * text out of annotations, so this is how the tests see what one shows.
 */
async function showAppearanceAlone(
  revisionBytes: Uint8Array,
  annotationIndex: number,
): Promise<Uint8Array> {
  const document = await PDFDocument.load(revisionBytes);
  const page = document.getPage(0);
  const annotation = document.context.lookup(
    page.node.Annots()!.asArray()[annotationIndex],
    PDFDict,
  );
  const appearanceRef = annotation
    .lookup(PDFName.of("AP"), PDFDict)
    .get(PDFName.of("N"));
  const appearance = document.context.lookup(appearanceRef);

  assert.ok(appearance instanceof PDFRawStream);

  const numbers = (array: PDFArray | undefined) =>
    array?.asArray().map((entry) => Number(entry.toString()));
  const [left, bottom, right, top] = numbers(
    appearance.dict.lookup(PDFName.of("BBox"), PDFArray),
  )!;
  const [a, b, c, d, e, f] = numbers(
    appearance.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray),
  ) ?? [1, 0, 0, 1, 0, 0];
  const corners = [
    [left, bottom],
    [left, top],
    [right, bottom],
    [right, top],
  ].map(([x, y]) => [a! * x! + c! * y! + e!, b! * x! + d! * y! + f!]);
  const xs = corners.map(([x]) => x!);
  const ys = corners.map(([, y]) => y!);
  const moved = [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ];
  const rect = numbers(annotation.lookup(PDFName.of("Rect"), PDFArray))!;
  const scaleX = (rect[2]! - rect[0]!) / (moved[2]! - moved[0]!);
  const scaleY = (rect[3]! - rect[1]!) / (moved[3]! - moved[1]!);
  const fit = [
    scaleX,
    0,
    0,
    scaleY,
    rect[0]! - moved[0]! * scaleX,
    rect[1]! - moved[1]! * scaleY,
  ];

  page.node.delete(PDFName.of("Annots"));
  page.node.set(
    PDFName.of("Resources"),
    document.context.obj({ XObject: { Shown: appearanceRef } }),
  );
  page.node.set(
    PDFName.of("Contents"),
    document.context.register(
      document.context.stream(`q ${fit.join(" ")} cm /Shown Do Q`),
    ),
  );

  return document.save();
}

function assertInside(
  point: { x: number; y: number },
  [left, bottom, right, top]: Box,
  what: string,
) {
  assert.ok(
    point.x >= left && point.x <= right && point.y >= bottom && point.y <= top,
    `${what}: ${point.x.toFixed(2)},${point.y.toFixed(2)} is not in ${[left, bottom, right, top].join(" ")}`,
  );
}

function assertClose(actual: readonly number[], expected: readonly number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]!) < 0.001,
      `${actual.join(" ")} is not ${expected.join(" ")}`,
    );
  });
}

function decodeStream(stream: PDFRawStream): string {
  return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
}

for (const pageCase of PAGE_CASES) {
  test(`import records the size of ${pageCase.name} as it is shown`, async () => {
    const source = await makeSource(pageCase);
    const imported = await importPdfDocument({
      body: source,
      contentType: "application/pdf",
      filename: "scan.pdf",
    });

    assert.deepEqual(imported.pages, [
      {
        heightPt: pageCase.displayed.height,
        pageNumber: 1,
        widthPt: pageCase.displayed.width,
      },
    ]);
  });

  test(`a value is stamped where its field was placed on ${pageCase.name}`, async () => {
    const source = await makeSource(pageCase);
    const pdfBytes = await finalize(
      source,
      [field({ id: "field-1", value: VALUE })],
      shownSize(pageCase),
    );
    const placed = await findText(pdfBytes, VALUE);

    assert.ok(placed, "the value was not found on the page");
    assertShownInField(placed, pageCase);
  });

  test(`a signer's revision puts its annotations over the fields on ${pageCase.name}`, async () => {
    const source = await makeSource(pageCase);
    const revision = await prepareSignerRevision(
      await prepareRevisionZero(source),
      {
        fields: [
          field({ id: "field-1", value: VALUE }),
          field({
            id: "field-2",
            inputMethod: "typed",
            type: "signature",
            value: SIGNATURE,
          }),
        ],
        images: new Map(),
        pages: shownSize(pageCase),
        signature: {
          fieldName: "Alice Example (signer 1)",
          signingTime: new Date(now * 1000),
        },
      },
    );
    const document = await PDFDocument.load(revision.bytes);
    const annotations = document
      .getPage(0)
      .node.Annots()!
      .asArray()
      .map((ref) => document.context.lookup(ref, PDFDict));

    // The text field's stamp and the signature's widget.
    assert.equal(annotations.length, 2);

    // Each shows its value, in the field and upright.
    for (const [index, value] of [VALUE, SIGNATURE].entries()) {
      const placed = await findText(
        await showAppearanceAlone(revision.bytes, index),
        value,
      );

      assert.ok(placed, `annotation ${index + 1} does not show "${value}"`);
      assertShownInField(placed, pageCase);
    }

    for (const annotation of annotations) {
      const appearance = annotation
        .lookup(PDFName.of("AP"), PDFDict)
        .lookup(PDFName.of("N"));

      assert.ok(appearance instanceof PDFRawStream);

      const numbers = (array: PDFArray) =>
        array.asArray().map((entry) => Number(entry.toString()));

      assertClose(
        numbers(annotation.lookup(PDFName.of("Rect"), PDFArray)),
        pageCase.fieldBox,
      );
      // The appearance is cut to the same rectangle, so it is shown as
      // drawn, and it is drawn turned the way the page is shown.
      assertClose(
        numbers(appearance.dict.lookup(PDFName.of("BBox"), PDFArray)),
        pageCase.fieldBox,
      );
      assert.equal(
        decodeStream(appearance).includes(" cm"),
        pageCase.matrix !== null,
      );

      if (pageCase.matrix) {
        assert.ok(decodeStream(appearance).includes(`${pageCase.matrix} cm`));
      }
    }
  });
}

// Envelopes imported before page sizes were read as shown stored the raw
// MediaBox. The sender placed fields on a box of that shape, with the shown
// page drawn in it as large as fits, centred. These tests place the field
// where FIELD_RECT is on the page drawn in that box, and check that it is
// stamped there.

/** The raw MediaBox size, as envelopes imported before stored it. */
function mediaBoxSize(pageCase: PageCase): StoredPageSize[] {
  const [left, bottom, right, top] = pageCase.mediaBox;

  return [{ heightPt: top - bottom, pageNumber: 1, widthPt: right - left }];
}

/** Where FIELD_RECT on the shown page is on a box of the stored shape. */
function placedOnStoredBox(pageCase: PageCase) {
  const [stored] = mediaBoxSize(pageCase);
  const { height, width } = pageCase.displayed;
  const scale = Math.min(stored!.widthPt / width, stored!.heightPt / height);
  const drawnWidth = (scale * width) / stored!.widthPt;
  const drawnHeight = (scale * height) / stored!.heightPt;

  return {
    height: FIELD_RECT.height * drawnHeight,
    width: FIELD_RECT.width * drawnWidth,
    x: (1 - drawnWidth) / 2 + FIELD_RECT.x * drawnWidth,
    y: (1 - drawnHeight) / 2 + FIELD_RECT.y * drawnHeight,
  };
}

for (const pageCase of PAGE_CASES) {
  test(`on ${pageCase.name} imported before sizes were read as shown, a value is stamped where its field was placed`, async () => {
    const source = await makeSource(pageCase);
    const pdfBytes = await finalize(
      source,
      [field({ ...placedOnStoredBox(pageCase), id: "field-1", value: VALUE })],
      mediaBoxSize(pageCase),
    );
    const placed = await findText(pdfBytes, VALUE);

    assert.ok(placed, "the value was not found on the page");
    assertShownInField(placed, pageCase);
  });

  test(`on ${pageCase.name} imported before sizes were read as shown, a signer's revision puts its annotation over the field`, async () => {
    const source = await makeSource(pageCase);
    const revision = await prepareSignerRevision(
      await prepareRevisionZero(source),
      {
        fields: [
          field({
            ...placedOnStoredBox(pageCase),
            id: "field-1",
            value: VALUE,
          }),
        ],
        images: new Map(),
        pages: mediaBoxSize(pageCase),
        signature: {
          fieldName: "Alice Example (signer 1)",
          signingTime: new Date(now * 1000),
        },
      },
    );
    const document = await PDFDocument.load(revision.bytes);
    const [annotation] = document
      .getPage(0)
      .node.Annots()!
      .asArray()
      .map((ref) => document.context.lookup(ref, PDFDict));

    assertClose(
      annotation!
        .lookup(PDFName.of("Rect"), PDFArray)
        .asArray()
        .map((entry) => Number(entry.toString())),
      pageCase.fieldBox,
    );

    const placed = await findText(
      await showAppearanceAlone(revision.bytes, 0),
      VALUE,
    );

    assert.ok(placed, "the annotation does not show the value");
    assertShownInField(placed, pageCase);
  });
}

test("a field on a page stored at the shape it is shown keeps its place", () => {
  const rect = { height: 0.1, width: 0.5, x: 0.1, y: 0.05 };

  // Same shape, other scale, as when a CropBox keeps the page's proportions.
  assert.equal(
    fieldOnDisplayedPage(
      rect,
      { heightPt: 800, widthPt: 600 },
      { heightPt: 400, widthPt: 300 },
    ),
    rect,
  );
  // Sizes as Postgres stores them, a little off in the last digits.
  assert.equal(
    fieldOnDisplayedPage(
      rect,
      { heightPt: 841.8900146484375, widthPt: 595.2760009765625 },
      { heightPt: 841.89, widthPt: 595.276 },
    ),
    rect,
  );
  // No stored size: nothing to correct against.
  assert.equal(
    fieldOnDisplayedPage(rect, undefined, { heightPt: 600, widthPt: 800 }),
    rect,
  );
});

test("a field placed on a portrait box over a landscape page moves to the page", () => {
  // A 600 x 800 box shows an 800 x 600 page at 600 x 450, 175 down from the
  // top: the page's top is at 0.21875 of the box, and it fills 0.5625 of it.
  const moved = fieldOnDisplayedPage(
    { height: 0.05625, width: 0.5, x: 0.1, y: 0.21875 + 0.05 * 0.5625 },
    { heightPt: 800, widthPt: 600 },
    { heightPt: 600, widthPt: 800 },
  );

  assertClose(
    [moved.x, moved.y, moved.width, moved.height],
    [0.1, 0.05, 0.5, 0.1],
  );
});
