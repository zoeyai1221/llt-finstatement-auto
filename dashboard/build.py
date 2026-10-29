import pathlib
d = pathlib.Path(__file__).parent
t = (d / "src/template.html").read_text()
for key, f in [("/*VENDOR_XLSX*/", "vendor/xlsx.full.min.js"), ("/*VENDOR_CHART*/", "vendor/chart.umd.min.js"), ("/*VENDOR_PDF_WORKER*/", "vendor/pdf.worker.min.js"), ("/*VENDOR_PDF*/", "vendor/pdf.min.js"), ("/*CORE*/", "src/core.js")]:
    js = (d / f).read_text().replace("</script", "<\\/script")
    t = t.replace(key, js)
(d / "index.html").write_text(t)
print("built", len(t) // 1024, "KB")
