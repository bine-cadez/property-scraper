import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifySchema } from "fastify";

export const SWAGGER_ROUTE_PREFIX = "/docs";

type OperationDocumentation = {
  summary: string;
  description: string;
};

const paragraphs = (...values: string[]): string => values.join("\n\n");

const apiDescription = paragraphs(
  "This API lets you explore property information published by **GURS**, the Surveying and Mapping Authority of the Republic of Slovenia. You can look up land, buildings, parts of buildings, official modelled values, and recorded property sales.",
  "### A few words that make the data easier to understand",
  "- A **cadastral municipality** is an official land-registration area. It is not necessarily the same thing as a local-government municipality.\n- A **parcel** is an officially registered piece of land.\n- A **building** is the whole registered structure.\n- A **building part** is a separately identified unit inside a building, such as a flat, office, shop, storage room, or parking space.\n- A **valuation unit** contains a GURS modelled value. This is an official estimate, not an asking price or a guaranteed current market price.\n- A **transaction** is a recorded property deal. One transaction can include several building parts or parcels, so its total price may cover more than one item.",
  "### How to use these pages",
  "An API key works like a password. Select **Authorize**, enter the value of `x-api-key`, and then you can try an endpoint. Endpoints without an ID show a list of matching records. Endpoints ending in `{id}` show one specific record and often include links to related information. Long lists are returned one page at a time.",
);

const operationDocumentation: Record<string, OperationDocumentation> = {
  "/health": {
    summary: "Check whether the service is running",
    description:
      "Returns a simple “ok” answer when the API itself is running. This does not check whether the property database can be reached; use the readiness check for that.",
  },
  "/ready": {
    summary: "Check whether property data is available",
    description:
      "Checks that the API can reach its database. A “ready” answer means requests for property data can be served. A “not ready” answer means the service is running but its data is temporarily unavailable.",
  },
  "/ingest/gurs": {
    summary: "Refresh the property data from GURS",
    description: paragraphs(
      "Starts a new import from GURS for a chosen transaction year. `sampleSize` controls how many recent transactions are used as the starting sample. The import also collects the buildings, building parts, parcels, values, and addresses connected to those transactions.",
      "This is a data-refresh action, not a search. Every successful download is saved as a checkpoint, so an interrupted run can reuse completed requests. When the complete import succeeds, it replaces the current live sample and removes its checkpoints. If it fails, the previous live data and the completed checkpoints are kept. The answer is a summary showing when the import ran, how large the sample was, and how many records were collected from each source.",
    ),
  },
  "/gurs/sources": {
    summary: "See where the current data came from",
    description:
      "Returns a list of the GURS datasets used to build the current database. Each item identifies a source dataset and when or for which reference date it was obtained. Use this to understand the origin and freshness of the data; it does not return individual properties.",
  },
  "/gurs/sources/:id": {
    summary: "See the details of one data source",
    description:
      "Returns one source record from the import history. It explains which GURS dataset was retrieved, when it was retrieved, and the date or coverage that dataset represents.",
  },
  "/gurs/statistics": {
    summary: "See an overview of how much data is available",
    description:
      "Returns total record counts for transactions, sold items, buildings, building parts, parcels, addresses, and cadastral municipalities. This is a quick coverage overview, not a calculation of prices, areas, or values.",
  },
  "/gurs/statistics/:resource": {
    summary: "Count one type of property record",
    description:
      "Returns a single total for the chosen category: transactions, buildings, building parts, parcels, or addresses. It is useful when you only need one count instead of the complete statistics overview.",
  },
  "/gurs/cadastral-municipalities": {
    summary: "Browse cadastral municipalities",
    description:
      "Returns official land-registration areas with their identifiers and names. These areas are used to organise parcels and buildings in the cadastre and should not be confused with local-government municipalities.",
  },
  "/gurs/cadastral-municipalities/:id": {
    summary: "View one cadastral municipality",
    description:
      "Returns the identifier and name of one cadastral municipality, together with links for finding the buildings and parcels registered in that area.",
  },
  "/gurs/addresses": {
    summary: "Browse official property addresses",
    description:
      "Returns address records connected to registered buildings. A record can include the full written address, street, settlement, municipality, postal code, and available location coordinates. A building may have more than one address.",
  },
  "/gurs/addresses/:id": {
    summary: "View one official address",
    description:
      "Returns one complete address record and a link to the building it belongs to. This is useful when you start with a house-number record and want to continue to the physical building.",
  },
  "/gurs/parcels": {
    summary: "Browse registered land parcels",
    description:
      "Returns pieces of land recorded in the cadastre. A parcel record can include its cadastral municipality, parcel number, area, administrative status, land rating, and available location information.",
  },
  "/gurs/parcels/:id": {
    summary: "View one land parcel and its connections",
    description: paragraphs(
      "Returns the details of one registered parcel, including its identity, area, status, and other available cadastral information.",
      "It also shows how many buildings, addresses, building parts, valuation units, and recorded sales are connected to the parcel, with links for opening those related records. A connected modelled value is an official estimate and should not be read as the parcel’s current sale price.",
    ),
  },
  "/gurs/buildings": {
    summary: "Browse registered buildings",
    description:
      "Returns whole structures recorded by GURS. A building record can include its cadastral area, building number, type, construction year, number of floors, gross floor area, address, and location. Flats and other individual units are listed separately as building parts.",
  },
  "/gurs/buildings/:id": {
    summary: "View one building and its connections",
    description:
      "Returns the details of one whole building. It also includes counts and links for its addresses, individual building parts, land parcels, valuation records, and recorded sales, making this the main starting point for exploring everything connected to a structure.",
  },
  "/gurs/building-parts": {
    summary: "Browse flats and other building units",
    description:
      "Returns separately registered units inside buildings, such as flats, offices, shops, storage rooms, or parking spaces. A record can include its actual use, floor, area, useful area, address, and the building it belongs to. It does not describe the whole building.",
  },
  "/gurs/building-parts/:id": {
    summary: "View one flat or other building unit",
    description:
      "Returns the details of one separately registered building part. It also links back to the whole building and to related addresses, parcels, official modelled values, and recorded sales.",
  },
  "/gurs/buildings/:id/valuation-units": {
    summary: "See official modelled values within a building",
    description:
      "Returns the GURS valuation records for the individual parts belonging to one building. These are official model-based estimates for the units inside the building; they are not asking prices and may differ from current market prices.",
  },
  "/gurs/building-parts/:id/valuation-units": {
    summary: "See the official modelled value of one building unit",
    description:
      "Returns the GURS valuation record connected to one flat or other building part, including its available modelled value and valuation details. Treat the value as an official estimate rather than a guaranteed selling price.",
  },
  "/gurs/parcels/:id/valuation-units": {
    summary: "See official modelled values for one parcel",
    description:
      "Returns the valuation units attached to one land parcel. The records can show the valued share, area share, and GURS modelled value. These are official estimates and do not necessarily represent the parcel’s current market price.",
  },
  "/gurs/transactions": {
    summary: "Browse recorded property deals",
    description: paragraphs(
      "Returns property transactions recorded by GURS. A transaction can include its contract date, type of deal, total price, VAT information, year, and other sale details.",
      "One deal may contain several parcels or building parts. The total price therefore belongs to the complete transaction and should not automatically be treated as the price of a single item.",
    ),
  },
  "/gurs/transactions/:id": {
    summary: "View one property deal and everything sold in it",
    description:
      "Returns the full transaction record plus the building parts and land parcels included in the deal. Where possible, sold items are connected to their current GURS property identifiers so you can continue from the sale to the matching building unit or parcel.",
  },
  "/gurs/code-lists": {
    summary: "Look up the meaning of GURS codes",
    description:
      "Returns the reference lists that translate coded GURS values into human-readable meanings. Use this when another record contains a type, use, status, or category code that is not self-explanatory.",
  },
  "/gurs/code-lists/:id": {
    summary: "Explain one GURS code-list entry",
    description:
      "Returns one code-list entry, including the list it belongs to, its stored value, and the available human-readable description.",
  },
  "/gurs/search": {
    summary: "Search for a place or property",
    description:
      "Searches across addresses, cadastral municipality names, parcel numbers, and building numbers at the same time. Each result says what kind of match it is, gives a readable label, and includes a link to the matching record. Use this as the easiest starting point when you do not already know an official record ID.",
  },
  "/map/tiles/:layer/:z/:x/:y.mvt": {
    summary: "Load property shapes and points for a map",
    description: paragraphs(
      "Returns the data a map application needs to draw one small section of the map. Choose `properties` for buildings, `sales` for recorded-sale locations, `parcels` for land boundaries, or `cadastral` for cadastral municipality boundaries.",
      "The answer is a Mapbox Vector Tile intended for mapping software, not a normal text or JSON response. At wide map views some point layers are grouped into clusters, and detailed parcel or building shapes only appear when the map is zoomed in far enough.",
    ),
  },
};

function tagFor(url: string): string {
  if (url.startsWith("/ingest/")) return "Ingestion";
  if (url.startsWith("/gurs/")) return "GURS";
  if (url.startsWith("/map/")) return "Map";
  return "System";
}

function documentedPathParameters(
  url: string,
): FastifySchema["params"] | undefined {
  const names = [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map(
    ([, name]) => name,
  );
  if (names.length === 0) return undefined;

  return {
    type: "object",
    required: names,
    properties: Object.fromEntries(
      names.map((name) => [
        name,
        name === "layer"
          ? {
              type: "string",
              enum: ["properties", "sales", "parcels", "cadastral"],
              description:
                "The kind of information to draw: buildings, sales, parcels, or cadastral areas.",
            }
          : name === "resource"
            ? {
                type: "string",
                enum: [
                  "transactions",
                  "buildings",
                  "building-parts",
                  "parcels",
                  "addresses",
                ],
                description: "The category you want to count.",
              }
          : name === "z"
            ? {
                type: "integer",
                minimum: 0,
                maximum: 22,
                description:
                  "How far the map is zoomed in, from 0 (the whole world) to 22 (very close).",
              }
            : name === "x" || name === "y"
              ? {
                  type: "integer",
                  minimum: 0,
                  description:
                    "The map tile position. Mapping software normally supplies this automatically.",
                }
              : {
                  type: "string",
                  description:
                    "The official identifier of the record you want to open.",
                },
      ]),
    ),
  };
}

export function registerSwagger(app: FastifyInstance): void {
  app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Property Scraper API",
        description: apiDescription,
        version: "0.1.0",
      },
      tags: [
        {
          name: "System",
          description: "Checks whether the service and its data are available",
        },
        {
          name: "Ingestion",
          description: "Refreshes the locally stored sample from GURS",
        },
        {
          name: "GURS",
          description:
            "Searches and explains Slovenian property, value, and sale records",
        },
        {
          name: "Map",
          description: "Supplies property locations and boundaries to a map",
        },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            name: "x-api-key",
            in: "header",
            description: "The API key configured through AUTH_KEY",
          },
        },
      },
      security: [{ apiKey: [] }],
    },
    transform: ({ schema, url }) => {
      const routeSchema = schema ?? {};
      const documentation = operationDocumentation[url];
      return {
        schema: {
          ...routeSchema,
          tags: routeSchema.tags ?? [tagFor(url)],
          ...(documentation
            ? {
                summary: routeSchema.summary ?? documentation.summary,
                description:
                  routeSchema.description ?? documentation.description,
              }
            : {}),
          params: routeSchema.params ?? documentedPathParameters(url),
        },
        url,
      };
    },
  });

  app.register(swaggerUi, {
    routePrefix: SWAGGER_ROUTE_PREFIX,
    staticCSP: true,
    uiConfig: {
      deepLinking: true,
      docExpansion: "list",
      filter: true,
      persistAuthorization: true,
      displayRequestDuration: true,
    },
    theme: {
      title: "Property Scraper API documentation",
    },
  });
}
