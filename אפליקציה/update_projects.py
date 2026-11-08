# -*- coding: utf-8 -*-
"""
Converts the Excel of special trees into projects.js for the app.
Each sheet = one project. Column A = tree number, Column B = status (שימור / העתקה).

Usage:  python update_projects.py  "עצים מיוחדים לשימור והעתקה.xlsx"
Then upload the new projects.js (and bump VERSION in sw.js) to update all phones.
"""
import sys, json, os, warnings
import openpyxl

warnings.filterwarnings("ignore")

def fmt_num(v):
    if v is None:
        return None
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        return repr(v)  # 23218.1 -> "23218.1"
    return str(v).strip()

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "עצים מיוחדים לשימור והעתקה.xlsx")
    wb = openpyxl.load_workbook(src, data_only=True)
    projects = []
    for ws in wb.worksheets:
        trees = []
        for row in ws.iter_rows(min_row=2, max_col=2, values_only=True):
            num, status = fmt_num(row[0]), (str(row[1]).strip() if row[1] else "")
            if not num:
                continue
            trees.append({"n": num, "s": status})
        projects.append({"name": ws.title.strip(), "trees": trees})
        print(f"{ws.title}: {len(trees)} עצים")
    out = os.path.join(here, "projects.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write("// נוצר אוטומטית מתוך האקסל ע\"י update_projects.py — לא לערוך ידנית\n")
        f.write("var PROJECTS = [\n" + ",\n".join(json.dumps(p, ensure_ascii=False) for p in projects) + "\n];\n")
    print(f"\nנכתב {out} — {len(projects)} פרויקטים")

if __name__ == "__main__":
    main()
