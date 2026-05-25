const cheerio = require("cheerio");

function getConditionText(conditionInfo, ...names) {
  for (const name of names) {
    const entry = (conditionInfo || []).find((c) => c.Name === name);
    if (entry?.DisplayValues?.[0]?.Text) return entry.DisplayValues[0].Text;
  }
  return "";
}

function parseFromVM(vm) {
  const ci = vm.ConditionInfo || [];

  const images = (vm.ThumbNailUrllst || []).map((src) =>
    src.replace("thumbnail", "resizer") + "&width=640&height=480",
  );

  const primaryDamage = getConditionText(ci, "PrimaryDamage");
  const secondaryDamage = getConditionText(ci, "SecdDamage", "SecondaryDamage");
  const otherDamage = getConditionText(ci, "OtherDamages");
  const damage = `${primaryDamage}, ${secondaryDamage}, ${otherDamage}`;

  const localDate =
    `${vm.Date || ""} ${vm.Month || ""} ${vm.LiveDateString || ""} ${
      vm.UserTimezoneAbb || ""
    }`.trim();

  return {
    make: vm.Make || "",
    model: vm.Model || "",
    vin: vm.VIN || "",
    year: vm.Year || "",
    engine: getConditionText(ci, "Engine"),
    transmission: getConditionText(ci, "Transmission"),
    mileage: getConditionText(ci, "Odometer"),
    stockNumber: vm.StockNo || "",
    fuelType: getConditionText(ci, "FuelType"),
    damage,
    brandText: getConditionText(ci, "VehicleBrand"),
    airbags: getConditionText(ci, "AirBags"),
    keysText: getConditionText(ci, "KeysPresent"),
    startsText: getConditionText(ci, "StartCode"),
    declarationText: getConditionText(ci, "Declarations"),
    formattedDate: localDate,
    localDate,
    dateTwo: vm.BuyNowCloseDate || "",
    formattedLane: vm.LaneRun || "",
    location: [vm.LocationName, vm.City, vm.Province].filter(Boolean).join(", "),
    images,
  };
}

function parseFromLegacyDOM($) {
  const imageSrcs = [];
  $("img").each((_idx, el) => {
    imageSrcs.push($(el).attr("src"));
  });
  const images = imageSrcs
    .filter((src) => src && src.includes("thumbnail"))
    .map((src) => src.replace("thumbnail", "resizer") + "&width=640&height=480");

  const findCell = (label) =>
    $(".conditBody div.conditTableRow")
      .filter((_i, el) => $(el).find(".conditLabel").text().includes(label))
      .find("span")
      .text()
      .trim();

  const make = $("span[data-bind=\"attr: {'aria-label': Make}, text: Make\"]")
    .text()
    .trim();
  const model = $("span[data-bind=\"attr: {'aria-label': Model}, text: Model\"]")
    .text()
    .trim();
  const year = $("span[data-bind=\"attr: {'aria-label': Year}, text: Year\"]")
    .first()
    .text()
    .trim();
  const stockNumber = $(
    "span[data-bind=\"attr: {'aria-label': StockNo}, text: StockNo\"]",
  )
    .first()
    .text()
    .trim();

  const primaryDamage = findCell("Primary Damage");
  const secondaryDamage = findCell("Secd. Damage");
  const otherDamage = findCell("Other Damages");
  const damage = `${primaryDamage}, ${secondaryDamage}, ${otherDamage}`;

  return {
    make,
    model,
    vin: findCell("VIN"),
    year,
    engine: findCell("Engine"),
    transmission: findCell("Transmission"),
    mileage: findCell("Odometer"),
    stockNumber,
    fuelType: findCell("Fuel Type"),
    damage,
    brandText: findCell("Vehicle Brand"),
    airbags: findCell("Air Bags"),
    keysText: findCell("Keys Present"),
    startsText: findCell("Start Code"),
    declarationText: findCell("Declarations"),
    formattedDate: "",
    localDate: "",
    dateTwo: "",
    formattedLane: "",
    location: "",
    images,
  };
}

function getCarDetailsFromHTML(html) {
  const $ = cheerio.load(html);
  const vmEl = $("#VehicleDetailsVM");
  if (vmEl.length) {
    try {
      const vm = JSON.parse(vmEl.text());
      if (vm) return parseFromVM(vm);
    } catch (_e) {
      // Fall through to legacy DOM parsing
    }
  }
  return parseFromLegacyDOM($);
}

/**
 * Build the Telegram-formatted description used by the Karavan Motors
 * channel. Kept verbatim from iaai-won-cars-bot/functions/readAndSend.js so
 * the published format remains consistent.
 */
function generateMessage(data) {
  const channelLink =
    '<a href="https://t.me/karavan_auctions">📢 @karavanmotors</a>';
  return (
    `<b>Karavan Motors</b>\n${channelLink}\n<b>Auction: IAAI</b>\n` +
    `Year: ${data.year}\nMake: ${data.make}\nModel: ${data.model}\n` +
    `Mileage: ${data.mileage}\nEngine: ${data.engine}\n` +
    `Transmission: ${data.transmission}\nFuel Type: ${data.fuelType}\n` +
    `VIN: ${data.vin}\nDamage: ${data.damage}\nBrand: ${data.brandText}\n` +
    `Airbags: ${data.airbags}\nKeys: ${data.keysText}\n` +
    `Starts: ${data.startsText}\nDeclarations: ${data.declarationText}\n\n` +
    `<b>Location: ${data.location}</b>\n` +
    `<b>Date Europe: ${data.formattedDate?.trim() || data.dateTwo}</b>\n` +
    `<b>Stock#: ${data.stockNumber}</b>\n` +
    `<b>Lane: ${data.formattedLane}</b>\n`
  );
}

function getCopartDetailsFromHTML(html, lotNumber) {
  const $ = cheerio.load(html);

  const labelValue = (label) =>
    $("label")
      .filter((_i, el) => $(el).text().includes(label))
      .next("span.lot-details-desc")
      .text()
      .trim();

  const make = $("h1.title").text().trim();
  const vin = $(".lot-details-desc").eq(1).text().trim();
  const primaryDamage = $('span[data-uname="lotdetailPrimarydamagevalue"]')
    .text()
    .trim();
  const engine = $('span[data-uname="lotdetailEnginetype"]').text().trim();
  const transmission = labelValue("Transmission");
  const drive = labelValue("Drive");
  const fuel = labelValue("Fuel");
  const keys = labelValue("Keys");
  const highlights = $(".highlights-popover-cntnt > span").text().trim();
  const notes = $('[data-uname="lotdetailNotesvalue"]').text().trim();
  const odometer = $('span[data-uname="lotdetailOdometervalue"] span span')
    .first()
    .text()
    .trim();
  const date = $('span[data-uname="lotdetailSaleinformationsaledatevalue"]')
    .text()
    .trim();
  const location = $('a[data-uname="lotdetailSaleinformationlocationvalue"]')
    .text()
    .trim();

  return {
    lotNumber: String(lotNumber),
    make,
    vin,
    primaryDamage,
    engine,
    transmission,
    drive,
    fuel,
    keys,
    highlights,
    notes,
    date,
    mileage: odometer,
    location,
    images: [],
  };
}

function generateCopartMessage(data) {
  const channelLink =
    '<a href="https://t.me/karavan_auctions">📢 @karavanmotors</a>';
  return (
    `<b>Karavan Motors</b>\n${channelLink}\n<b>Auction: Copart</b>\n` +
    `Make: ${data.make}\nMileage: ${data.mileage}\nEngine: ${data.engine}\n` +
    `Transmission: ${data.transmission}\nDrive: ${data.drive}\n` +
    `Fuel: ${data.fuel}\nKeys: ${data.keys}\n` +
    `VIN: ${data.vin}\nPrimary Damage: ${data.primaryDamage}\n` +
    `Highlights: ${data.highlights}\nNotes: ${data.notes}\n\n` +
    `<b>Location: ${data.location}</b>\n` +
    `<b>Sale Date: ${data.date}</b>\n` +
    `<b>Lot#: ${data.lotNumber}</b>\n` +
    `<a href="${data.link}">View on Copart</a>\n`
  );
}

module.exports = {
  getCarDetailsFromHTML,
  generateMessage,
  getCopartDetailsFromHTML,
  generateCopartMessage,
};
