import { describe, expect, it, vi } from "vitest";
import type { Transport } from "../../../src/core/forecast/openMeteoClient";
import {
  GeocodeError,
  NOMINATIM_BASE_URL,
  searchPlaces,
  shortPlaceName,
} from "../../../src/core/travel/geocode";
import placesJSON from "../../fixtures/nominatim-boulder.json?raw";
import placesURL from "../../fixtures/nominatim-boulder.url.txt?raw";

function respond(body: string, status = 200): ReturnType<typeof vi.fn<Transport>> {
  return vi.fn<Transport>(async () => ({ status, body }));
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { lat: "40.0", lon: "-105.0", display_name: "Somewhere, Colorado", ...overrides };
}

async function rejection(promise: Promise<unknown>): Promise<GeocodeError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(GeocodeError);
    return e as GeocodeError;
  }
  throw new Error("expected searchPlaces to reject");
}

describe("searchPlaces", () => {
  it("requestsTheRecordedSearch", async () => {
    const transport = respond(placesJSON);
    await searchPlaces("Boulder, Colorado", transport);
    const sent = new URL(transport.mock.calls[0]![0]);
    const recorded = new URL(placesURL.trim());
    // The recording was made with "+" for the space; encodeURIComponent writes "%20". Same query.
    expect(sent.origin).toBe(recorded.origin);
    expect(sent.pathname).toBe(recorded.pathname);
    expect([...sent.searchParams]).toEqual([...recorded.searchParams]);
    expect(NOMINATIM_BASE_URL).toBe(recorded.origin);
  });

  it("parsesTheRecordedResponseInOrderWithNumericCoordinates", async () => {
    const places = await searchPlaces("Boulder, Colorado", respond(placesJSON));
    expect(places).toEqual([
      {
        name: "Boulder, Boulder County, Colorado, United States",
        coordinate: { latitude: 40.0149856, longitude: -105.270545 },
      },
      {
        name: "Boulder County, Colorado, United States",
        coordinate: { latitude: 40.102555, longitude: -105.3632079 },
      },
    ]);
  });

  it.each(["", "   ", "\n\t"])("makesNoRequestForAnEmptyQuery: %j", async (query) => {
    const transport = respond(placesJSON);
    expect(await searchPlaces(query, transport)).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("trimsTheQuery", async () => {
    const transport = respond("[]");
    await searchPlaces("  Boulder, Colorado  ", transport);
    expect(new URL(transport.mock.calls[0]![0]).searchParams.get("q")).toBe("Boulder, Colorado");
  });

  it("encodesSpecialCharacters", async () => {
    const query = "A&B #1/?é=x+y";
    const transport = respond("[]");
    await searchPlaces(query, transport);
    const url = transport.mock.calls[0]![0];
    const [path, search] = url.split("?") as [string, string];
    expect(path).toBe("https://nominatim.openstreetmap.org/search");
    expect(search).not.toContain("#");
    expect(search.split("&")).toHaveLength(3);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("q")).toBe(query);
    expect(parsed.searchParams.get("format")).toBe("jsonv2");
    expect(parsed.searchParams.get("limit")).toBe("5");
    expect(parsed.searchParams.has("countrycodes")).toBe(false);
  });

  it("usesTheGivenBaseURLWithoutATrailingSlash", async () => {
    const transport = respond("[]");
    await searchPlaces("x", transport, "http://localhost:8080/");
    expect(transport.mock.calls[0]![0]).toMatch(/^http:\/\/localhost:8080\/search\?q=x&/);
  });

  it("keepsOnlyTheValidResults", async () => {
    const body = JSON.stringify([
      null,
      "Boulder",
      result({ lat: "", display_name: "Empty lat" }),
      result({ lat: " ", display_name: "Blank lat" }),
      result({ lat: "abc", display_name: "Not a number" }),
      result({ lat: "91", display_name: "Too far north" }),
      result({ lat: "-91", display_name: "Too far south" }),
      result({ lon: "-181", display_name: "Too far west" }),
      result({ lon: "181", display_name: "Too far east" }),
      result({ lat: "Infinity", display_name: "Infinite" }),
      result({ display_name: 42 }),
      result({ display_name: "  " }),
      result({ display_name: "" }),
      { lat: "40.0", lon: "-105.0" },
      { display_name: "No coordinates" },
      result({ lat: null, display_name: "Null lat" }),
      result({ display_name: "Good one", lat: "-90", lon: "180" }),
      result({ display_name: "Good two", lat: "12.5", lon: "-12.25" }),
    ]);
    expect(await searchPlaces("x", respond(body))).toEqual([
      { name: "Good one", coordinate: { latitude: -90, longitude: 180 } },
      { name: "Good two", coordinate: { latitude: 12.5, longitude: -12.25 } },
    ]);
  });

  it("returnsAtMostFivePlacesEvenIfTheServerSendsMore", async () => {
    const body = JSON.stringify(
      Array.from({ length: 7 }, (_, i) => result({ display_name: `Place ${i}`, lat: String(i) })),
    );
    const places = await searchPlaces("x", respond(body));
    expect(places.map((p) => p.name)).toEqual(["Place 0", "Place 1", "Place 2", "Place 3", "Place 4"]);
  });

  it("anEmptyArrayIsNoPlaces", async () => {
    expect(await searchPlaces("zzzzzz", respond("[]"))).toEqual([]);
  });

  it("rejectsANon200Status", async () => {
    const err = await rejection(searchPlaces("x", respond("[]", 429)));
    expect(err.kind).toBe("http");
    expect(err.status).toBe(429);
  });

  it.each([
    ["an error object", '{"error":{"code":400,"message":"bad"}}'],
    ["a string", '"hello"'],
    ["null", "null"],
    ["not JSON", "<html>busy</html>"],
  ])("rejectsABodyThatIs: %s", async (_name, body) => {
    const err = await rejection(searchPlaces("x", respond(body)));
    expect(err.kind).toBe("unexpectedShape");
    expect(err.detail).not.toBe("");
  });

  it("wrapsATransportFailure", async () => {
    const cause = new Error("network down");
    const transport: Transport = async () => {
      throw cause;
    };
    const err = await rejection(searchPlaces("x", transport));
    expect(err.kind).toBe("transport");
    expect(err.cause).toBe(cause);
  });
});

describe("shortPlaceName", () => {
  it("takesTheTextBeforeTheFirstComma", () => {
    expect(shortPlaceName("Boulder, Boulder County, Colorado, United States")).toBe("Boulder");
  });

  it("returnsTheWholeNameWithoutAComma", () => {
    expect(shortPlaceName("Boulder")).toBe("Boulder");
  });

  it("trimsWhitespace", () => {
    expect(shortPlaceName("  Boulder , Colorado")).toBe("Boulder");
  });
});
