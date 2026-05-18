// AFI Jira Active Roster — 17 BUs, 91 projects.
// Sourced verbatim from AFIJiraActiveRosterHandoff.md (2026-05-15).
// Do not invent new BU groupings; do not re-bucket.
module.exports = [
  {
    slug: "afi-data-analytics",
    name: "AFI Data & Analytics",
    projects: [
      { key: "ARA",   name: "AGR Retail Analytics",                 category: "Team" },
      { key: "ASCNO", name: "AI - Supply Chain Network Optimization", category: "Team" },
      { key: "BW",    name: "BI - Wholesale",                       category: "Team" },
      { key: "BA",    name: "BI ADS",                                category: "Team" },
      { key: "CDA",   name: "DATA - Central Data Analytics",         category: "Team" },
      { key: "BDE",   name: "DATA - Data Warehouse and Data Engineering", category: "Team" },
      { key: "DBA",   name: "DATA - DBA",                            category: "Team" },
      { key: "EDA",   name: "DATA - Enterprise Data Architecture",   category: "Team" },
      { key: "MM",    name: "DATA - MarTech Marvels",                category: "Team" },
      { key: "DIS",   name: "Data Integration and Solutions",        category: "Team" },
      { key: "DCSH",  name: "Data- Customer Service Hub",            category: "Team" },
      { key: "DCC",   name: "DP: Catalog of catalogs",               category: "Team" },
      { key: "DP",    name: "EDME-Customer Experience(RCM)",         category: "Team" },
      { key: "DW",    name: "EDME-Enterprise Operations",            category: "Team" },
      { key: "EDME",  name: "EDME-Order to Delivery",                category: "Team" },
      { key: "DDF",   name: "EDME-Plan& Make to Stock/Order",        category: "Team" },
      { key: "EAS",   name: "Enterprise Analytics and Semantics",    category: "Team" },
      { key: "GD",    name: "Global Data",                            category: "Discovery" },
      { key: "GDKB",  name: "Global Data Product Kanban Board",      category: "Team" },
      { key: "GSCA",  name: "Global Supply Chain Analytics",         category: "Team" }
    ]
  },
  {
    slug: "afi-retail-agr",
    name: "AFI Retail (AGR)",
    projects: [
      { key: "APD",  name: "AGR Product Discovery",                  category: "Discovery" },
      { key: "APU",  name: "AGR Product Management / UX / Engineering", category: "Discovery" },
      { key: "EAG",  name: "Eagle Eyes",                              category: "Team" },
      { key: "EE",   name: "Encore Engineers",                        category: "Team" },
      { key: "LIG",  name: "LightVision",                             category: "Team" },
      { key: "RTS",  name: "Retail Technology Systems",               category: "Support" },
      { key: "SPAR", name: "Spartan",                                 category: "Team" },
      { key: "SI",   name: "Splash Impact",                           category: "Team" },
      { key: "SN",   name: "Storis/NextGen",                          category: "Team" }
    ]
  },
  {
    slug: "afi-distribution-transportation",
    name: "AFI Distribution & Transportation",
    projects: [
      { key: "DTD",  name: "Distribution & Transportation Discovery", category: "Discovery" },
      { key: "GTMG", name: "Global Trade Management (GTM)",           category: "Team" },
      { key: "GTM",  name: "Global Trade Management Discovery",       category: "Discovery" },
      { key: "TRAN", name: "Transportation",                          category: "Team" },
      { key: "WR",   name: "WMS Retail",                              category: "Team" },
      { key: "WRPD", name: "WMS Retail Product Discovery",            category: "Discovery" },
      { key: "WW",   name: "WMS Wholesale",                           category: "Team" },
      { key: "WPD",  name: "WMS Wholesale Product Discovery",         category: "Discovery" }
    ]
  },
  {
    slug: "afi-it-technology",
    name: "AFI IT / Technology",
    projects: [
      { key: "AIE",    name: "AI Enablement",                  category: "Team" },
      { key: "DBAFOG", name: "DBA Foglight",                   category: "Support" },
      { key: "DEVOPS", name: "DevOps",                         category: "Team" },
      { key: "DOPLAN", name: "DevOps Planning",                category: "Discovery" },
      { key: "EAT",    name: "Enterprise Architecture",        category: "Team" },
      { key: "GIT",    name: "Global Infrastructure Technology", category: "Team" },
      { key: "SRE",    name: "SRE",                            category: "Team" }
    ]
  },
  {
    slug: "afi-manufacturing",
    name: "AFI Manufacturing",
    projects: [
      { key: "BOG",    name: "Boots on the Ground",            category: "Support" },
      { key: "MD",     name: "Manufacturing Discovery",        category: "Discovery" },
      { key: "MAXEHS", name: "Maximo/EHS",                     category: "Team" },
      { key: "MIAPS",  name: "MFG IT - Advanced Planning & Scheduling", category: "Team" },
      { key: "MIACS",  name: "MFG IT - APAC & Control Systems", category: "Team" },
      { key: "MIES",   name: "MFG IT - Execution Systems",     category: "Team" },
      { key: "MISS",   name: "MFG IT - Shopfloor Systems",     category: "Team" }
    ]
  },
  {
    slug: "afi-plm-product",
    name: "AFI PLM / Product",
    projects: [
      { key: "PLMCC", name: "PLM - Creative Content",          category: "Team" },
      { key: "PLM",   name: "PLM - Design/Engineering",        category: "Team" },
      { key: "PPIM",  name: "PLM - Product Data Platform",     category: "Team" },
      { key: "PD",    name: "PLM Discovery",                   category: "Discovery" },
      { key: "PQD",   name: "PQS - Discovery",                 category: "Discovery" },
      { key: "PQS",   name: "PQS - Product Quality Systems",   category: "Team" }
    ]
  },
  {
    slug: "afi-shared-services",
    name: "AFI Shared Services",
    projects: [
      { key: "AESMT", name: "Ashley Enterprise Service Management Team", category: "Team" },
      { key: "EDI",   name: "EDI",                             category: "Team" },
      { key: "ES",    name: "EDI Standard",                    category: "Team" },
      { key: "ERP",   name: "ERP - Production and Inventory Control", category: "Team" },
      { key: "JSC",   name: "Jira Support Center",             category: "Support" }
    ]
  },
  {
    slug: "afi-ecommerce-digital",
    name: "AFI eCommerce / Digital",
    projects: [
      { key: "AGRDIG", name: "ASaaSsins",              category: "Team" },
      { key: "DE",     name: "Digital-Experimentation", category: "Team" },
      { key: "MOB",    name: "Mobile App",              category: "Team" },
      { key: "MS",     name: "Mystery Machine",         category: "Team" },
      { key: "SSF",    name: "SFCC Strike Force",       category: "Team" }
    ]
  },
  {
    slug: "afi-finance",
    name: "AFI Finance",
    projects: [
      { key: "FA",   name: "Finance Aspirants",                category: "Team" },
      { key: "FRP",  name: "Finance Reporting and Pricing",    category: "Team" },
      { key: "NEX",  name: "Nexus",                            category: "Team" },
      { key: "SHAR", name: "Shared Services Discovery",        category: "Discovery" }
    ]
  },
  {
    slug: "afi-international-apac",
    name: "AFI International (APAC/Vietnam)",
    projects: [
      { key: "AAVD",  name: "AFI APAC Vietnam Discovery",      category: "Discovery" },
      { key: "QC",    name: "QIS & Customization",             category: "Team" },
      { key: "WAOPD", name: "WMS Asia Operations Product Discovery", category: "Discovery" },
      { key: "XW",    name: "X Work",                          category: "Team" }
    ]
  },
  {
    slug: "afi-ai-innovation",
    name: "AFI AI & Innovation",
    projects: [
      { key: "AID", name: "AI & Innovation Discovery",         category: "Discovery" },
      { key: "ATL", name: "AI - ThunderCloud Labs",            category: "Team" },
      { key: "AE",  name: "AI-Enigma",                         category: "Team" }
    ]
  },
  {
    slug: "afi-order-management",
    name: "AFI Order Management",
    projects: [
      { key: "OP",  name: "OPRO-GCC",                          category: "Team" },
      { key: "OMS", name: "Order Management",                  category: "Team" },
      { key: "SSD", name: "Sales and Service Discovery",       category: "Discovery" }
    ]
  },
  {
    slug: "afi-supply-chain",
    name: "AFI Supply Chain",
    projects: [
      { key: "DSI", name: "Demand, Supply & Inventory",        category: "Team" },
      { key: "GSM", name: "Global Supplier Management",        category: "Team" },
      { key: "SCD", name: "Supply Chain Discovery",            category: "Discovery" }
    ]
  },
  {
    slug: "afi-hr-people",
    name: "AFI HR / People",
    projects: [
      { key: "INC", name: "iNcredibles",                       category: "Team" },
      { key: "KVN", name: "Kaavalan",                          category: "Team" }
    ]
  },
  {
    slug: "afi-wholesale",
    name: "AFI Wholesale",
    projects: [
      { key: "SS", name: "Sales and Service",                  category: "Team" },
      { key: "SE", name: "Sales Enablement",                   category: "Discovery" }
    ]
  },
  {
    slug: "agr-customer-care",
    name: "AGR Customer Care",
    projects: [
      { key: "MEL", name: "Melody Makers",                     category: "Team" },
      { key: "RR",  name: "Rhythm Raiders",                    category: "Team" }
    ]
  },
  {
    slug: "afi-cybersecurity",
    name: "AFI Cybersecurity",
    projects: [
      { key: "SA", name: "CyberSecurity",                      category: "Team" }
    ]
  }
];
